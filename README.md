# Coin Radar

Private Solana research dashboard with market discovery, X evidence, budget-based conditional allocation, recorded manual positions and entry/exit review alerts. No wallet connection, signing, swaps or custody.

## Runtime and setup

Vinext/React on Cloudflare Workers, hosted by OpenAI Sites. Cloudflare D1 is declared as DB in `.openai/hosting.json`. Sites publishing applies the migrations in `drizzle/` before the new Worker goes live; see [Database and deployment](#database-and-deployment). The Site remains private.

X requires an `X_BEARER_TOKEN` server-side secret set in Sites environment settings and a publication applying that environment revision. Never put credentials in browser storage, source, or chat. Configure an X developer-console spending limit, then set a daily request cap in Advisor. Default cap is zero. No paid requests run automatically.

## API

- `GET /api/market`: latest DEX Screener profiles + promoted Solana tokens; up to 30 addresses, highest-liquidity pool per base token.
- `GET /api/market?q=<symbol-or-address>`: Solana-only search. Confirm exact contracts.
- `GET /api/market?addresses=<addresses>`: watchlist batch, up to 30.
- `GET /api/news`: CoinDesk RSS headlines, five-minute best-effort cache.
- `GET /api/portfolio`: authenticated user config, open recorded positions, latest 100 events.
- `POST /api/portfolio`: authenticated same-origin config/record-position/mark-closed actions. Validates input. Position IDs make retries idempotent. The 30 open-position limit is applied atomically. No trade execution.
- `GET /api/advisor?address=<mint>`: fresh market screening plus conditional position ceiling. API allocation remains zero while safety is unverified. Frontend can calculate a conditional amount after explicit manual review.
- `POST /api/monitor`: authenticated same-origin position check. Reads exact recorded pools, updates observed peaks, emits one durable event per position and rule. Per-user lock prevents overlapping checks. Closed positions excluded.
- `GET /api/social[?address=<mint>]`: connection state, cached evidence, daily usage. No paid request.
- `POST /api/social` with `{address}`: authenticated same-origin on-demand exact-contract X recent search; max 25 posts, author IDs and engagement counts, 15-minute D1 cache. No user expansions. Includes sample deduplication; does not claim whole-market social velocity. Per-contract lock and atomic per-user UTC daily request cap. Failed attempts conservatively consume the request allowance. Provider billing can differ from request count; enforce dollar spend at X.
- `POST /api/goldmine`: authenticated same-origin Goldmine scan under one shared lock. Settles due signal outcomes, then scores the discovery set with Momentum Score v2 and records each priced candidate once per state and six-hour bucket. Never trades, sizes positions or requests X. See [docs/goldmine-intelligence.md](docs/goldmine-intelligence.md).
- `GET /api/goldmine`: authenticated, read-only. The 50 most recent signals with their 15m/1h/6h/24h outcomes, and per-state outcome counts for the current model version.
- `GET /api/health`: authenticated, read-only check that D1 is reachable and has every table and column the routes use. Returns `ok`/`compatible`, or 503 with `storage: unavailable` or `schema: incompatible`. No writes, no provider requests, no schema details in the response.

Route failures write one redacted JSON line per failure (`coin_radar.failure`, with route, operation, level and error) to the Worker log. Records never include request bodies, user identifiers, email addresses or credentials; see [docs/deployment-runbook.md](docs/deployment-runbook.md).

All monetary inputs are USD. Access relies on private Sites sign-in. Do not make public with paid integrations without reviewing access and abuse protection.

## Advisor rules

Heuristic screen: liquidity 0/15/25 points; daily volume 0/20; positive hourly change up to 20; buy-count bias 0/20; pool age 0/15. Candidate needs >=65 and no market flags. Paid boosts/social posts add no points. Weights have no validated predictive performance.

Conditional amount = min(total speculative budget × chosen full-loss percent, budget × allocation cap percent, budget − recorded open principal). Missing budget, failed market screen, missing evidence, or unreviewed safety produces zero. The entire suggested principal can be lost; a loss alert is not a guaranteed stop. Inputs and default percentages are user-controlled examples, not an optimization or personalized financial assessment.

Holder concentration, mint/freeze authorities, sellability and liquidity locks are still not automatically verified. Manual safety acknowledgement is explicitly labelled as user review, not a safety certificate. X posts cannot override safety flags or increase position size.

## Positions and alerts

Positions, risk config, observed peaks, X cache/usage and exit events persist in D1 by authenticated user. Entry watchlist/settings/history remain device-local from version 1. Record only manually completed trades with actual entry price and amount; inferred quantity excludes fees. All open exposure must be recorded for the allocation ceiling to be meaningful. Mark a position closed only after manually closing; update the configured budget for realized P&L. Wallet balances and fills are not synced.

Position rules: profit target, loss threshold, trailing pullback from observed peak, liquidity drop from opening snapshot, unavailable price/liquidity. Thresholds are fixed at position creation; default edits affect future positions. One event per rule per position, persisted across reloads. Historical event display does not imply an ongoing condition.

Monitoring runs every 15 seconds only while the mounted dashboard is open and monitoring is enabled. Remains mounted when switching dashboard tabs. Provider snapshots may be delayed; the 10-second best-effort server cache is not a freshness guarantee. Background tabs may be throttled. The opening liquidity snapshot comes from the selected pool data available when recording, not historical entry liquidity. Only observed peaks are known. User notification permission and browser support required for desktop alerts; no successful delivery guarantee.

**Always-on scheduler and mobile push are not configured or implemented in this hosting integration. Closing the app stops monitoring. This version must not be relied upon as an emergency exit system.** A hosted background runner and a delivery channel are required before making that claim. No automated buy/sell transactions are in scope.

## Validation

Node 22.13 or newer. Run `npm ci` first.

| Command | Runs |
| --- | --- |
| `npm run verify` | `typecheck`, `lint`, `test`, `build` in that order; stops at the first failure. `test` starts with the migration tests and `build` starts with the migration check. |
| `npm run typecheck` | `tsc --noEmit` without writing `tsconfig.tsbuildinfo`. |
| `npm run lint` | ESLint. Violations that existed before Stage 02 are recorded in `eslint-suppressions.json`; any new violation fails. |
| `npm test` | `test:migrations`, then all other offline tests in `tests/` (Node test runner). |
| `npm run test:migrations` | Migration safety tests only; see [Database and deployment](#database-and-deployment). |
| `npm run test:research` | Advisor and market logic only. Also `node --experimental-strip-types scripts/check-research.mjs`. |
| `npm run test:social-cache` | X cache isolation only. Also `node --experimental-strip-types --test scripts/check-social-cache.mjs`. |
| `npm run test:browser` | Playwright smoke tests (not part of `verify`). Needs Chromium: `npx playwright install chromium`. |
| `npm run test:worker` | Builds, then runs the built-Worker HTTP regression (not part of `verify`). |

Test groups:

- `advisor.test.mjs`: position sizing vetoes, caps, cent rounding and settings boundaries; exact loss, profit, trailing and liquidity thresholds (equality triggers each rule); unavailable price/liquidity; observed peaks; social sample summary.
- `market.test.mjs`: input sanitizing, pair normalization, every score and warning boundary, verdicts, safe links; paid promotion never changes the result.
- `social-cache.test.mjs`: two users sharing one cache row, legacy row projection, per-request quota and connection state, fresh/stale/zero-cap paths, removed credential, atomic quota, provider failure and malformed responses, contract lock release, auth and same-origin guards.
- `portfolio-route.test.mjs`, `advisor-route.test.mjs`, `monitor-route.test.mjs`, `research-db.test.mjs`: auth, same-origin, validation, per-user isolation, idempotent recording, the 30-position limit, zero API allocation, social exclusion, per-user monitor locks, durable event deduplication, outages and lock release.
- `health-route.test.mjs`: sign-in guard, one read-only probe per required table, missing binding, a binding that throws while preparing, missing table or column reported only in failure records, schema errors wrapped as a cause, storage errors taking precedence.
- `post-body.test.mjs`: the POST routes answer 401, 403 and social's missing-secret 409 without reading the body, and the monitor never reads it; malformed or non-object JSON is a 400 with no storage, lock, X quota, provider call or failure record. The Worker entry reads every unread body to the end before responding (1 MiB and slow bodies included, with no read-ahead), even after vinext cancels its view of the body; a failing body or a throwing handler never changes the outcome.
- `goldmine-score.test.mjs`: snapshot normalization (malformed, negative and implausible provider values become missing data), the scoring oracle in `helpers/goldmine-fixtures.mjs` (exact points for reference candidates, every hard gate, state rules, fail-closed opportunity status, clamping, and removing any one or two inputs never raising a score, unlocking an entry state or creating an opportunity), determinism, explanations and wording.
- `goldmine-mutation.test.mjs`: 22 deliberately broken copies of `lib/goldmine/score.ts` (a gate removed, a threshold moved, fail-closed turned fail-open, unassessed risk checks earning points); the oracle must reject every one.
- `goldmine-route.test.mjs`: auth, same-origin and missing-binding guards, recorded evidence equal to the served assessment, no user data in shared signals, six-hour deduplication, cached X evidence without X requests, outcome windows (observed, missed, unavailable, provider failure left pending), batches of at most 30 pools with a failed batch left pending and a five-request cap that defers instead of skipping, signal writes in chunks of 10, lock release and statistics.
- `market-route.test.mjs`: `/api/market` discovery (both feeds, boosted flags, the 30-token cap, one failed feed, provider failures), shared with the Goldmine scan.
- `diagnostics.test.mjs`: redaction of credentials, bearer tokens in any case and emails; record format and levels; reporting never throws; failure records from portfolio, advisor, monitor (including lock release), social, market and news without response changes; validation errors are not failures.
- `migrations/structure.test.mjs`: journal, file and snapshot ordering, duplicate and missing migrations, the immutability lock, the build's migration check and the migration CLI.
- `migrations/fresh.test.mjs`: every migration applied once, in order, to a new temporary database file; the schema contract the routes rely on (`migrations/schema-contract.mjs`); every application SQL statement compiled against the result and against the tables and columns `/api/health` probes (`lib/schema-requirements.ts`); parity with `db/schema.ts`; a real read/write round trip.
- `migrations/upgrade.test.mjs`: populated databases (`migrations/upgrade-fixtures.mjs`, including pre-Stage-02 shared X cache rows and Goldmine signals with settled and pending outcomes) upgraded from every historical version with no data lost or changed, then served by the real portfolio, monitor, social and Goldmine routes; self-tests proving destructive or incompatible migrations are reported.

Route tests run the real route handlers and `lib/research-db.ts` against an in-memory SQLite database built by applying every migration listed in `drizzle/meta/_journal.json`, through a D1-shaped adapter. Only runtime boundaries are replaced: Cloudflare `env`, Sites authentication headers and `fetch`. DEX Screener, CoinDesk and X responses are fixtures. No test makes a network request, uses real credentials or touches production D1; no live X request is made.

The built-Worker regression (`tests/worker/`) starts `dist/` the way `npm start` does, on a free local port with a temporary migrated local D1 and fake sign-in headers. Over real HTTP it sends small, empty, larger-than-64-KiB, slow chunked (finishing after 1.5 s) and abandoned bodies: to every 401 and 403 path, the monitor, social's missing-secret 409, malformed portfolio and social JSON, every unsupported method on every API route (vinext's own 405) and an unknown path (vinext's 404). It checks each complete response, sends a signed-in health check on the same connection after each, and fails if the Worker stops or its debug log shows `Can't read from request stream after response has been sent` or Wrangler's "restarted" response. The requests end before any provider call. It stops only the process tree it started, confirms none of it survives and removes its temporary state. CI runs it in the `Browser smoke` job.

`worker/entry.ts` is the Worker entry: it hands vinext a pull-through view of each request body and, once the response is ready, reads whatever is left of the original body to the end before returning it (`lib/request-body.ts`). vinext cancels a body a route did not read, and cancelling does not prevent workerd's error, so the original body is kept out of its reach. See the runbook's limitations for the trade-offs.

Browser smoke (`e2e/`) starts the local dev server (mock Sites sign-in, local Miniflare) and fulfils every `/api/*` call in the browser from fixtures, aborting any non-local request. It covers initial render, provider outage, tab switching, device-local watchlist/alert settings, signed-out and unavailable Advisor account states, and horizontal overflow at 320, 360 and 390 px. It does not cover authenticated D1 flows, real providers or production hosting.

GitHub Actions runs `npm run verify` and the Chromium browser smoke suite on Linux for every pull request and every push to `main`. Browser traces are retained for seven days when the smoke job fails. CI never deploys, and Sites publishing does not wait for it.

Known limitations, not changed in Stage 02:

- Monitor and social locks expire after 60 seconds. A scan longer than that can overlap the next; event IDs prevent duplicate events, but overlapping scans can write an older observed peak.
- Configuration saves are last-writer-wins across tabs. `revision` columns are incremented but not checked.
- Failed paid X attempts consume the reserved request, by design. The daily cap uses the UTC date.
- Allocation rounding can land one cent below an exact cent value, never above.
- No migration is required for Stage 02.

## Database and deployment

Coin Radar is published through OpenAI Sites. `npm run build` first checks the migration history, then copies `drizzle/` into the build. Sites publishing applies pending migrations to the production D1 database (binding `DB`) one at a time, **before** the new Worker goes live, so the code already running must keep working on the new schema. The checklist, deployment sequence, smoke checks, rollback options and failure matrix are in [docs/deployment-runbook.md](docs/deployment-runbook.md).

| Command | Scope |
| --- | --- |
| `npm run test:migrations` | Offline. Checks migration structure and the lock, builds a fresh database from every migration, upgrades populated databases from every historical version, and runs the real routes against the results. Included in `npm test` and `npm run verify`. |
| `npm run db:migrations:check` | Offline. Validates `drizzle/` and `db/migrations.lock.json`. `npm run build` runs the same check and refuses to build on failure. |
| `npm run db:generate` | Offline. Generates a migration from `db/schema.ts`. |
| `npm run db:migrations:list:local`, `npm run db:migrate:local` | Local preview D1 in `.wrangler/state` only; run `npm run build` first. They accept no arguments, so `--remote` cannot be passed. |
| `npm run verify`, `npm run test:browser` | Offline and local, as described under Validation. |
| Sites publish | **Remote.** Applies production migrations, then deploys. Only the Site owner performs it, through the Sites plugin, after the runbook checklist. |

The repository has no remote migration script. Do not run Wrangler with `--remote`, or `wrangler deploy`, against this project: Sites owns the production database, and applying migrations outside publishing bypasses its migration record.

Migration rules:

- Applied migrations are immutable. `db/migrations.lock.json` records a hash of every migration; editing, renaming, reordering or removing one fails the build and CI. Treat everything merged to `main` as applied.
- A schema change is always a new migration: edit `db/schema.ts`, run `npm run db:generate`, add seed and verify coverage for the new tag in `tests/migrations/upgrade-fixtures.mjs`, then append the lock entry printed by `npm run db:migrations:check`.
- Prefer additive changes. Destructive or data-rewriting migrations need a data-preservation plan and a confirmed recovery point before publishing (see the runbook).

## Provider documentation

- https://docs.dexscreener.com/api/reference
- https://docs.phantom.com/developer-powertools/token-pages
- https://docs.x.com/x-api/getting-started/pricing
- https://developers.cloudflare.com/workers/configuration/cron-triggers/
