# Scan capacity safeguards for a future 96-invocation/day detector (not an activation)

This records what is actually implemented against draft PR #22's capacity concerns, ahead of any
15-minute cadence. It changes nothing about when a scan runs: the Vercel cron stays daily
(`0 0 * * *`, `vercel.json`), the Cloudflare Worker (PR #23) stays undeployed, and nothing here
sends an alert, prunes data, or auto-trades.

## What is implemented here

- **A persisted RugCheck cooldown** (`lib/goldmine/contract-safety.ts`, `RUGCHECK_COOLDOWN_MS`,
  `rugCheckCooldownState`/`startRugCheckCooldown`). A 429 anywhere in `checkContractSafety` starts
  a cooldown recorded in the existing `research_locks` table (no migration: it is exactly the
  `{id, expires}` shape a cooldown needs, under its own id, namespaced apart from the
  `goldmine:scan` lock). A later call - this process or a genuinely fresh serverless invocation,
  since nothing here is in-memory - sends no RugCheck request while the cooldown is active,
  leaving candidates at their existing `contractSafety` (the same fail-closed shape a 429 or the
  existing per-call cap already produce). A report already in the instance's 10-minute cache costs
  no request and is still used. If the cooldown row cannot be read, the call behaves as if the
  cooldown were active (no request, candidates stay unavailable) instead of aborting detection.
  `RUGCHECK_COOLDOWN_MS` is 30 minutes: twice the 15-minute cadence draft PR #22 targets, chosen so
  a sustained outage is actually suppressed across at least one full scheduled cycle, not a
  measured RugCheck limit (RugCheck publishes none unauthenticated). The database parameter is
  optional and additive; every existing caller/test that omits it keeps today's per-call-only
  behavior exactly.
- **Why sharing `research_locks` is safe.** Both writes are single atomic statements. The scan
  lease (`acquireLock`) upserts only its own id and only when that row has expired;
  `releaseLock` deletes by id *and* owner. The cooldown upsert touches only
  `goldmine:rugcheck-cooldown` and only ever extends its expiry, so two overlapping 429s cannot
  shorten it. The other lease ids are `goldmine:scan`, `monitor:<user>` and `social:<address>`,
  none of which can collide. Expiry compares epoch milliseconds from each instance's own clock;
  NTP-level skew between serverless instances (milliseconds) is negligible against 30 minutes.
  Tests prove an active cooldown never makes a scan `busy` and a released lease never deletes it.
- **Explicit, observable scan-outcome metrics** (`lib/diagnostics.ts`, `reportScanOutcome`). Every
  invocation of `app/api/goldmine/scheduled/route.ts` (both GET and POST) now emits one structured
  `coin_radar.scan_outcome` JSON log line with its route, mode (`daily`/`detection`) and status
  (`checked`/`busy`/`provider_unavailable`), plus `durationMs`, candidate/opportunity/new-signal
  counts, `outcomesSettled` and a `safety` block (`eligible`, `verified`/`unsafe`/`unavailable`,
  RugCheck `requests`/`cacheHits`, `rateLimited`, `cooldown`, `unchecked`). The scan response
  carries the same `safety` block. `checked` means the pipeline ran; it does **not** mean safety
  checks ran. A rate-limited or cooling-down RugCheck stage still reports `checked`, and `safety`
  is what shows it. The fields are copied one by one from counts, so no candidate, address,
  provider body or secret can reach the line. Unauthorized requests and 503 failures emit no scan
  outcome (a failure still emits its `coin_radar.failure` record).

Both are covered by `tests/goldmine-contract-safety.test.mjs` and
`tests/goldmine-scheduled.test.mjs`, including a 96-invocation simulation against a RugCheck that
always returns 429 (the cooldown roughly halves the wasted requests instead of one per invocation)
and a same-mint repeat across those invocations that still respects the existing six-hour signal
bucket.

## What this deliberately does not add

- No new database table or migration. No alert delivery or its persistent idempotency ledger. No
  30-day pruning, archive, or export tooling. No change to discovery's 30-token cap, RugCheck's
  `MAX_CHECKS_PER_SCAN`/`SCAN_BUDGET_MS`, the six-hour signal bucket, or the 2,000-row backtest
  read window (`lib/goldmine/signals.ts`) - all already bounded and already tested before this PR.

## Storage growth at 96 detections/day: a projection, not a measurement

`signalId()` buckets a given `(address, state)` pair into one of four six-hour windows per day
(`lib/goldmine/signals.ts` `SIGNAL_BUCKET_MS`), and `recordSignals`'s `INSERT OR IGNORE` collapses
repeats within a bucket regardless of how many times detection runs inside it. Discovery caps a
scan at 30 Solana tokens (`lib/market.ts`). So worst-case new rows per day from *any* detection
cadence, including 96/day, is bounded by roughly (30 addresses) x (distinct states seen per
address per day, realistically small) x (4 buckets) - a few hundred rows/day at the extreme, not
thousands, and not a function of how often the detector runs. This is the existing bound in the
code, unchanged by this PR; 96 invocations/day make it easier to reach the upper end of that
range in practice, not raise it.

Against that: `MAX_RETAINED_SIGNALS` (2,000 rows) is the backtest read's cap, and
`readAllSignalsWithOutcomes` already reports `truncated: true` honestly once history exceeds it
rather than silently dropping old rows from a claimed full-history read. At a few hundred
rows/day worst case, 2,000 rows covers very roughly a week to a few weeks of full history before
truncation starts - not the 30-day live research window the owner is targeting. Reaching that
window without truncation needs either a higher cap (more D1/Turso query and memory cost per
backtest read - see `MAX_WORST_CASE_QUERIES`) or an archive-aware analysis, neither of which is
implemented here.

**Unverified in this session, and not assumed:** Turso's actual free-tier row-count, storage and
read/write-request quotas, and RugCheck's real unauthenticated rate-limit window. Before enabling
a 15-minute cadence, check the Turso dashboard against the projection above and re-derive it from
real observed volume rather than this worst-case bound.
