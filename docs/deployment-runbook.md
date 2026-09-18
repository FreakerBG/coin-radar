# Coin Radar deployment and recovery runbook

For whoever publishes or operates Coin Radar: the repository owner and the Site-owning Codex agent. It describes this repository as it is, not generic Cloudflare practice. Statements marked **Unverified** could not be confirmed from the repository, its tooling or the installed Sites plugin documentation; treat them as manual prerequisites.

Labels used below:

- **LOCAL**: reads or writes only this checkout, the OS temp directory or local preview state. Safe to run at any time.
- **REMOTE**: changes the hosted Site or its production D1 database. Only the Site owner may do it, only through Sites publishing.

## 1. How Coin Radar is deployed

| Topic | Verified state |
| --- | --- |
| Runtime | vinext (Vite-based Next.js) compiled to a Cloudflare Worker (`worker/entry.ts` wrapping `vinext/server/fetch-handler`, `nodejs_compat`), hosted by OpenAI Sites. The Site is private; Sites injects `oai-authenticated-user-*` headers after Sign in with ChatGPT. |
| Hosted environments | One: the production Site identified by `project_id` in `.openai/hosting.json`. The generated Worker config has no `env` sections and no `preview_database_id`. No hosted staging or preview environment exists. |
| D1 | One logical binding, `DB` (`.openai/hosting.json` `"d1": "DB"`). Sites provisions and owns the production database; its ID is not in this repository. `vite.config.ts` and `dist/server/wrangler.json` use the placeholder `site-creator-d1` / `00000000-0000-4000-8000-000000000000` for local simulation only. |
| R2 | None (`"r2": null`). |
| Secrets | `X_BEARER_TOKEN`, set in Sites environment settings. A publish applies the environment revision. Never commit or print it. |
| Local preview | `npm run dev` (mock sign-in, Miniflare) and `npm start` (the built Worker via `wrangler dev --local`) share the local D1 in `.wrangler/state`, which `npm run db:migrate:local` migrates. Nothing local touches production. |
| How migrations reach production | `npm run build` first runs the migration check (section 3), then copies `drizzle/` to `dist/.openai/drizzle`. Sites publishing applies pending migrations to production D1 **individually, recording each, before uploading the Worker** (Sites plugin 0.1.65, `persistence-and-storage.md`). A failed publish can therefore leave some or all migrations applied while the previous Worker keeps serving. |
| Who publishes | The Site-owning Codex agent with the Sites plugin: commit, push to the Sites source repository, `npm run build`, package, save a version, deploy. GitHub is a separate remote; GitHub Actions never deploys and cannot block a publish. GitHub `main` is branch-protected (section 9). |
| Rollback primitive | Sites keeps saved versions; a stored version can be deployed again by its version ID. Redeploying never reverts the D1 schema or data. |

**Unverified:** the table name and transaction scope Sites uses to record production migrations, whether it rejects deploying a version whose `drizzle/` is older than what has been applied, and whether production Worker logs are available to the owner (`observability` is enabled in the generated config).

Two tracking rules exist in this toolchain, and a malformed history makes them disagree. Drizzle's D1 migrator applies journal entries whose `when` is newer than the last recorded one and never compares file contents. Wrangler applies `.sql` files whose names are not yet recorded. The migration check requires numbering, file names and timestamps to agree, so both rules select the same pending migrations.

## 2. Command reference

| Command | Scope | What it does |
| --- | --- | --- |
| `npm ci` | LOCAL | Install locked dependencies. |
| `npm run verify` | LOCAL | `typecheck`, `lint`, `test`, `build` in order; stops at the first failure. CI runs this. |
| `npm test` | LOCAL | `test:migrations`, then every other offline test in `tests/`. |
| `npm run test:migrations` | LOCAL | Migration structure, fresh-database and upgrade tests on temporary SQLite files. No network. |
| `npm run test:browser` | LOCAL | Playwright smoke against the local dev server; non-local requests are aborted. |
| `npm run test:worker` | LOCAL | Builds, then starts the built Worker with `wrangler dev --local` on a free port and a temporary local D1 (migrated with `--local`), sends requests with bodies over HTTP, then stops it and deletes the state. No provider or Cloudflare account is contacted. |
| `npm run db:migrations:check` | LOCAL | Validate `drizzle/` and `db/migrations.lock.json`. Reads files only. |
| `npm run db:generate` | LOCAL | `drizzle-kit generate`: writes a new migration from `db/schema.ts`. No database connection. |
| `npm run build` | LOCAL | Migration check, then the deployable build in `dist/`. Does not deploy. |
| `npm run db:migrations:list:local` | LOCAL | List migrations not yet applied to the local preview D1. Needs a prior `npm run build`. |
| `npm run db:migrate:local` | LOCAL | Apply pending migrations to the local preview D1 through Wrangler with `--local` (tracked in its `d1_migrations` table). Needs a prior `npm run build`. |
| `npm run dev`, `npm start` | LOCAL | Local preview servers. Neither deploys. |
| Sites publish (save and deploy a version) | **REMOTE** | Applies pending production migrations, then uploads the Worker. Sites plugin only, by the Site owner. |

The `db:*:local` commands reject every extra argument, so `--remote` or `--preview` cannot be passed through. Wrangler's output still says "add a --remote flag"; that hint does not apply here.

There is deliberately **no remote migration script**. Do not run `wrangler d1 migrations apply --remote`, `wrangler d1 execute --remote` or `wrangler deploy` for this project: the production database belongs to Sites, the repository has no real database ID, and a direct change would bypass the migration record Sites keeps, risking double-applied or skipped migrations.

## 3. Migration authoring policy

| Rule | How it is enforced |
| --- | --- |
| Applied migrations are immutable. Treat every migration merged to `main` or ever published as applied; production state cannot be queried from here. | `db/migrations.lock.json` stores each migration's tag, journal `when` and SHA-256 of its SQL and snapshot (line endings normalized). `npm run build`, `npm run db:migrations:check` and the tests refuse any change, rename, reorder or removal. |
| Each schema change gets a new, ordered migration generated from `db/schema.ts`. Never renumber or squash. | The check requires journal `idx` 0..n without gaps, tags numbered like their position, strictly increasing `when`, a `.sql` file and chained snapshot per entry, and no unlisted or duplicate-numbered `.sql` files. A test fails if `db/schema.ts` and the migrated schema differ. |
| Prefer additive, backward-compatible changes: add, deploy code that uses it, remove old structures only in a later release. | Review. Sites runs migrations before the new Worker is live, so the **currently deployed code must work on the new schema**. |
| Destructive changes (dropping or renaming tables or columns, table rebuilds, tighter constraints, data rewrites) need a written data-preservation plan and a verified recovery point. | The upgrade test fails when any pre-existing table, column, row or value changes, unless that migration's fixture declares the change in `changes` with a reason. The recovery point is a manual gate (section 4). |
| Keep migrations schema-only and bounded (Sites rule): no seed or backfill datasets, no large `VALUES` lists. An added column's default must be constant; `NOT NULL` needs a non-null constant default; an added `REFERENCES` column must be nullable. | SQLite rejects the invalid `ALTER TABLE` forms when the tests apply the migration; the rest is review. |
| Every migration needs fresh-database and upgrade-path coverage. | `tests/migrations/fresh.test.mjs` applies the whole chain to a new file. `tests/migrations/upgrade.test.mjs` requires one entry per migration in `tests/migrations/upgrade-fixtures.mjs` and upgrades a populated database from every historical version. |
| Review migration order and deploy order together, including rollback compatibility. | Review checklist in section 4. |
| A remote migration runs only with a verified recovery point. | Manual gate in section 4. |

**Unverified D1 difference:** Drizzle's SQLite table-rebuild migrations issue `PRAGMA foreign_keys=OFF`. The migration tests apply each migration inside a transaction, where SQLite ignores that pragma, so foreign keys stay enforced during the tests; `npm run db:migrate:local` runs through Miniflare instead. Whether production D1 honors the pragma was not verified. Before publishing a rebuild of a table that other tables reference, check current Cloudflare D1 documentation. The schema has no foreign keys today.

### Adding a migration

1. Change `db/schema.ts`, then run `npm run db:generate` and read the generated SQL in full.
2. In `tests/migrations/upgrade-fixtures.mjs`, add an entry for the new tag. `seed` inserts representative rows valid right after the migration. `verify` checks that the real routes still serve them. Add `changes` only for intentional data rewrites.
3. If the application's requirements change, update `requiredTables` in `tests/migrations/schema-contract.mjs` in the same change.
4. Run `npm run test:migrations`. Optionally rehearse locally with `npm run build` and `npm run db:migrate:local`, then use `npm run dev`.
5. Run `npm run db:migrations:check` and append the entry it prints to `db/migrations.lock.json`. Never edit an existing entry. (A draft that has never been merged or published may be re-locked while it changes.)
6. Run `npm run verify`, open a pull request and wait for both CI jobs to pass.

## 4. Pre-deployment checklist

Complete every item before a REMOTE publish. Record the results with the deployment.

1. **Reviewed commit.** Publish only a commit on `origin/main` that went through a pull request. In the checkout used for publishing:
   ```sh
   git fetch origin
   git status --porcelain        # must print nothing
   git rev-parse HEAD origin/main # must print the same SHA twice
   ```
2. **CI.** Both `Verify` and `Browser smoke` succeeded for that SHA: `gh run list --commit <sha>`.
3. **Local gate on the publishing machine.** `npm ci` and `npm run verify` pass. This also proves the build gate passed.
4. **Environment and bindings.** Compare with the last deployed commit (`<last>`):
   ```sh
   git diff <last> HEAD -- .openai/hosting.json cloudflare-env.d.ts vite.config.ts
   ```
   `project_id`, `d1: "DB"` and `r2: null` must be unchanged unless the change is the reviewed purpose of this release. In Sites environment settings, confirm `X_BEARER_TOKEN` is present only if X research should be active. Do not display its value.
5. **Migration review.**
   ```sh
   git diff --stat <last> HEAD -- drizzle db/schema.ts db/migrations.lock.json
   git diff <last> HEAD -- db/migrations.lock.json   # only appended entries are acceptable
   npm run db:migrations:check
   ```
   Read each new `.sql` file against the policy in section 3. Record the tags this publish will apply.
6. **Compatibility.** For each new migration, answer in writing:
   - Old code, new schema: will the currently deployed Worker keep working after the migration? This state always occurs during a publish and after any failed Worker upload. Required: yes.
   - New code, old schema: Sites uploads the Worker only after its migrations succeed, and the migration check prevents silently skipped migrations, so this should not occur. Confirm that `dist/.openai/drizzle/meta/_journal.json` in the build being published lists every new migration.
   - Application rollback: after this migration, can the last known-good version still run? If not, application rollback is not a recovery option for this release; say so in the approval.
7. **Recovery checkpoint.** No backup, export or restore tooling exists in this repository, and D1 recovery-point availability for the Sites-owned database is **unverified**.
   - Additive migrations only (new tables, nullable or constant-default columns, new indexes): record "no existing data rewritten".
   - Anything destructive or data-rewriting: **manual prerequisite.** Obtain written confirmation from the Sites platform (OpenAI) that a restorable point-in-time recovery point exists for this Site's D1 database, with its timestamp and the restore procedure. Without it, do not publish; split the change into additive steps.
8. **Record the rollback target.** Note the Sites version ID of the currently deployed, known-good version.
9. **Approvals.** The repository owner approves the pull request merge, the publish and, separately, any destructive migration. Record the SHA, migration tags, recovery reference, rollback version ID, approver and time.

## 5. Safe migration and deployment sequence

1. **Recovery checkpoint.** REMOTE, manual, provider-side; only for destructive or data-rewriting migrations (section 4, item 7). Stop here if it cannot be confirmed.
2. **Local migration validation.** LOCAL.
   ```sh
   npm ci
   npm run verify                   # includes test:migrations and the build gate
   npm run db:migrations:list:local # after verify's build; shows what is pending locally
   npm run db:migrate:local
   npm run dev                      # sign in at /signin-with-chatgpt?return_to=/ and exercise section 6 locally
   ```
   To rehearse on an empty preview database, delete `.wrangler/state` first (local preview data only). A preview database that was migrated by hand with `wrangler d1 execute --file` has no migration record; `db:migrate:local` then fails with "table already exists" instead of changing it. Reset `.wrangler/state` in that case.
3. **Preview or staging validation.** Not available: no hosted preview or staging environment exists. The substitute is step 2 plus the upgrade tests, which run the real routes against production-shaped data. Creating a separate staging Site is a platform decision (section 9).
4. **Remote migration status check.** Not available from this repository: no tooling can query production migration records. Instead, confirm the last publish reported success (Sites `get_deployment_status`) and that the lock's earlier entries are unchanged since the last deployed commit (section 4, item 5). If the last publish failed or its outcome is unknown, go to section 7 before continuing.
5. **Migration application.** REMOTE. Part of the Sites publish: the Site owner saves and deploys the version built from the reviewed SHA. Sites applies pending migrations individually before the Worker upload. There is no separate command. Do not start a second publish while one is running.
6. **Application deployment.** REMOTE. The same publish uploads the Worker after migrations succeed. Wait for `get_deployment_status` to report `succeeded`.
7. **Smoke verification.** REMOTE, read-mostly; section 6. Record the results with the new version ID.

## 6. Post-deployment smoke checks

Use the production URL in a desktop browser with the Network panel open, signed in as the Site owner. The Site is private, so checks run in a signed-in session; `curl` cannot sign in. None of these checks needs a paid X request.

| Area | Check | Pass |
| --- | --- | --- |
| Authentication | In a private window, open the Site. Then sign in normally. | Signed out, the Site demands sign-in before content loads. Signed in, the dashboard renders. |
| Storage and schema | In the signed-in tab, open `/api/health`. | 200 with `"status":"ok"`, `"storage":"ok"` and `"schema":"compatible"`. A 503 with `"schema":"incompatible"` means the deployed code needs a table or column production lacks: stop (section 8). A 503 with `"storage":"unavailable"` is a D1 binding or D1 failure. The check is read-only and covers tables and columns, not constraints. |
| Portfolio load | Open the Advisor tab. | `GET /api/portfolio` returns 200 with settings, open positions and events as before the deploy. A 503 "Research storage unavailable" is a storage or schema failure. |
| Portfolio save | Save the risk settings without changing them, then reload. | `POST /api/portfolio` returns `{"ok":true}` and the reloaded values are identical. This is a harmless write (it increments `revision`). Record or close positions only if a closed test record in the history is acceptable. |
| Advisor and research | Select a coin in Discover and open Advisor. | `GET /api/advisor` returns 200. This makes one free DEX Screener read. A 503 while `/api/portfolio` returns 200 points at the provider, not the schema. |
| Monitoring | Enable monitoring on the dashboard. | `POST /api/monitor` returns `idle`, `checked` or `provider_unavailable`. A 503 "Position monitoring failed" is a storage or lock failure. With no open positions, no provider is called. |
| Social/X cache isolation | Open X evidence for a coin that already has cached evidence. **Do not** press "Research selected coin on X" unless a billed request is intended. | `GET /api/social?address=…` returns 200. `usedToday` and `dailyLimit` belong to the signed-in account, and posts contain only `text`, `date`, `url` and `author`. With a second authorized account, both see identical posts but their own quotas. |
| Mobile navigation | At 320–390 px wide (device toolbar or a phone), switch Discover, Watchlist, Advisor and Alerts. | Every tab opens and the page never scrolls horizontally. |
| Goldmine | In the signed-in tab, run `fetch('/api/goldmine', {method: 'POST'}).then(r => r.json())` in the console, then open `/api/goldmine`. | The scan returns `status` `checked` (or `provider_unavailable` during a DEX Screener outage) with scored candidates, each with components and rejections or blockers, and `opportunities` `0` while contract safety is unavailable. `GET` returns 200 with the recorded signals. This writes shared signal rows only; it makes no X request and no trade. A 503 is a storage or schema failure (`goldmine` failure records). |
| Runtime errors | Reload the dashboard and watch the Network panel. | No unexpected 5xx. Market or news 502s with provider-unavailable messages are provider outages (section 8). If Worker logs are available, check for `coin_radar.failure` records since the deploy (section 7). |

If any check fails, stop and use sections 7 and 8.

## 7. Rollback and recovery

Reverting application code does **not** revert the D1 schema or restore deleted or transformed data. Four operations exist, and they are not interchangeable:

| Operation | What it changes | How | When it is safe |
| --- | --- | --- | --- |
| Application rollback | Worker code only | REMOTE: redeploy the recorded known-good Sites version by its version ID. | Only when that version works on the current schema. After additive migrations it normally does. After a removal or rename it may not. **Unverified:** how Sites treats a version whose `drizzle/` is older than the applied migrations. Confirm with the platform before relying on this after a schema change. |
| Data recovery | Rows and values | REMOTE, provider-side, manual: a point-in-time restore of the Sites-owned D1, if one exists (**unverified**). No repository tooling can export or restore production data. | Only with platform support. A point-in-time restore also discards every legitimate write after that point; decide explicitly. |
| Schema reversal | Tables, columns, indexes | A new forward migration that restores the needed structure (for example, re-adding a column). Down migrations are not used. | Always preferred over editing history. Old data is not restored by re-adding structure. |
| Roll forward | Code and schema | A corrective migration and/or code fix through the full policy (section 3) and checklist (section 4). | The default response when production data is intact. |

### Stop the deployment when

- a publish returns a migration error, or its outcome is unknown;
- any section 6 check fails after deploy;
- `npm run db:migrations:check` or CI fails for the commit about to be published;
- the applied/unapplied migration boundary is uncertain;
- data looks missing, duplicated or changed.

Do not retry the same archive repeatedly, publish other changes on top, or edit migration files while investigating.

### Preserve evidence

Record, without secrets or tokens: the commit SHA, Sites version and deployment IDs, the complete publish or deployment error text, timestamps, the tags recorded in `db/migrations.lock.json` and in the deployed version's `dist/.openai/drizzle/meta/_journal.json`, the failing requests (method, path, status, response body; the app's error bodies contain no credentials), the `/api/health` response, `coin_radar.failure` log records for the incident window if Worker logs are available, CI run links and the smoke-check results.

### Read failure records

Every route failure writes one JSON line to the Worker log. This record came from `/api/health` against a local preview database with a column removed:

```json
{"event":"coin_radar.failure","level":"error","route":"health","operation":"probe:research_locks","error":{"name":"Error","message":"D1_ERROR: no such column: expires at offset 18: SQLITE_ERROR","cause":{"name":"Error","message":"no such column: expires at offset 18: SQLITE_ERROR"}}}
```

- `level: "error"` is a storage, schema or unexpected failure. `level: "warn"` is an upstream provider failure (`market`, `news` and `monitor` with `provider`; `social` with `x-search`) that the app already handles.
- Two operations handle storage and provider failures in one place and always log `error`: `advisor` `evidence` (D1 reads and DEX Screener) and `social` `research` (D1, and X network failures, timeouts or malformed responses). Tell them apart by the error: `Provider returned <status>`, `X returned errors without data` or a timeout/network error name is the provider; `D1_ERROR` is storage.
- `route` and `operation` locate the code path. `health` records use `probe:<table>` and name the failing table.
- Messages are truncated and redacted: the configured X credential, bearer tokens and email addresses are removed, and records never include request bodies, user identifiers or SQL parameters.

### Identify the affected migration

1. The publish error usually names the failing migration.
2. Otherwise, list the journal tags added since the last known-good commit: `git diff <last> <sha> -- drizzle/meta/_journal.json`. Only those can have run during this publish.
3. Map the failing symptom to a table: `health` records name it directly, and `requiredTables` in `lib/schema-requirements.ts` lists the routes that depend on each table.

### A migration failed during publish

The Sites platform documents one exception to immutability. If a publish returns a deterministic `SQLITE_*` error for a specific migration, and that migration is confirmed **unapplied**:

1. Correct only that migration and its matching, also unapplied, snapshot or journal metadata. Appending a new correction migration does not bypass an earlier failed one.
2. In `db/migrations.lock.json`, remove the entries for that migration and any later, also unapplied, migrations. Run `npm run db:migrations:check` and append the entries it prints. Leave every earlier entry untouched.
3. Reproduce the failure in `tests/migrations/upgrade-fixtures.mjs` where possible, pass `npm run verify` and CI, then publish a new version.

Migrations earlier in the same publish may already be applied; they stay immutable. If which migrations were applied cannot be established, **stop**: do not rewrite history or retry, and escalate to the platform.

### Verify recovery

- Every check in section 6 passes on the recovered deployment.
- The data spot checks match the evidence: settings, open positions and recent events per affected account.
- After a roll forward, the corrective commit passed `npm run verify`, CI and code review, and its upgrade fixture reproduces the situation it fixes.
- Record what was lost, if anything, including writes discarded by a restore.

### Manual Cloudflare or OpenAI intervention is required to

- restore or inspect production D1 data or schema (no repository tooling can read production);
- establish which migrations Sites has recorded when a publish outcome is unclear;
- confirm or perform a point-in-time recovery;
- diagnose production D1 outages;
- obtain Worker logs, if the platform provides them.

## 8. Failure matrix

| Situation | Immediate action | Application rollback safe? | Database recovery required? | Verify before resuming |
| --- | --- | --- | --- | --- |
| Migration fails before the Worker upload | Stop publishing and preserve evidence. The previous Worker keeps serving, possibly on a partly migrated schema. Identify the failing migration and which earlier ones were applied. | Not needed: the old version is still live. Run the section 6 checks to confirm it works on the current schema. | No, if the applied migrations were additive. Yes, if an applied migration rewrote data. | The failing migration is confirmed unapplied; it is corrected under section 7; `npm run verify` and CI pass; section 6 passes after the next publish. |
| Migrations succeed, Worker deploy fails | Preserve the deployment status. Old code is running on the new schema. Resolve the upload cause and redeploy the same saved version; applied migrations do not run again. | Not applicable: the old version is live. The policy requires it to work on the new schema; confirm with section 6. | No. | `get_deployment_status` reports `succeeded`; section 6 passes. |
| Deploy succeeds, smoke checks fail | Classify the failure with `/api/health` and failure records: schema (`schema: incompatible`), storage (`storage: unavailable`, or `error` records), provider (health 200, 502/503 from advisor, market or news, and `warn` records or advisor `evidence` records naming the provider; section 7) or UI. For a code defect, redeploy the known-good version. | Yes after additive migrations. No if a migration removed or renamed something that version uses; roll forward instead. | Only if new code or a migration damaged data. | Section 6 passes on the running version; the defect is reproduced by a test and fixed; roll forward through section 4. |
| Partial or incompatible schema state | Stop all publishes. Do not edit migrations or the lock. `/api/health` reports `schema: incompatible` and its `probe:<table>` records name the tables. Preserve evidence and escalate to the platform to read production migration records and schema. | Only to a version confirmed compatible with the actual schema. | Possibly, with platform support. | The applied migrations are known and reconciled with `db/migrations.lock.json`; a corrective forward migration passes tests with a fixture that reproduces the real state. |
| Corrupted or missing data | Preserve evidence and bound the time window. If the current code is causing it, redeploy the known-good version to stop further damage. Pause optional writes: disable monitoring and avoid X research and settings changes. | Yes, when new code is the cause. | Yes: a platform point-in-time restore (**unverified**) or a derivable corrective migration. | Per-account spot checks match expectations; section 6 passes; lost writes are documented. |
| Provider or API outage unrelated to schema (DEX Screener, CoinDesk, X) | Do not roll back or migrate. Confirm `/api/health` and `/api/portfolio` return 200 while provider routes return their unavailable messages, monitoring reports `provider_unavailable`, and failure records are `warn` level, except advisor `evidence` and social `research` records, which are `error` with a provider message (section 7). | Not needed. | No. | The provider recovers and section 6 passes. |

## 9. Limitations and open manual settings

- **Branch protection:** GitHub `main` is protected. Changes arrive only through pull requests; `Verify` and `Browser smoke` must pass on a branch that is up to date with `main`; review conversations must be resolved; the rules apply to administrators; force-pushes and branch deletion are blocked. Zero approving reviews are required, because there is no eligible independent reviewer, so a green pull request can be merged by its author.
- **Request bodies are read to the end before every response** (`worker/entry.ts`). Returning while a body is unread makes workerd report `Can't read from request stream after response has been sent` ([cloudflare/workerd#918](https://github.com/cloudflare/workerd/issues/918), open); under `wrangler dev` that breaks Wrangler's dev proxy and the next request fails or hangs. Consequences: a client that uploads slowly delays only its own response until it finishes or disconnects, and an unauthenticated body is read (not stored) before its 401. There is no application size or time cutoff, because cancelling an unfinished body brings the failure back; request size and duration are bounded only by the hosting platform. The failure was reproduced only in local `wrangler dev`; production impact is unverified.
- **Publishing bypasses CI:** Sites publishing builds from the publisher's checkout. The build gate enforces migration structure and immutability; the full test suite runs only when `npm run verify` or CI runs.
- **No hosted staging environment:** validation before production is local only.
- **No production migration status, backup, export or restore tooling** in this repository; D1 recovery-point availability is unverified.
- **Undocumented platform internals:** the Sites migration record table, per-migration transaction scope, and version-rollback behavior after schema changes.
- **Local engine differences:** the tests use `node:sqlite` (SQLite bundled with Node), not D1. `npm run db:migrate:local` runs the migrations in Miniflare's local D1, but neither engine proves production D1 behavior for `PRAGMA foreign_keys` during table rebuilds.
- **Diagnostics depend on log access:** routes write redacted `coin_radar.failure` records, but whether the Site owner can read production Worker logs through Sites is unverified. `/api/health` works without log access.
