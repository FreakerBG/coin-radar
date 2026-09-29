# Capacity model: 96 detections/day (a model, not a measurement)

For the owner deciding whether a 15-minute detection-only cadence is safe on the free tiers in use.
Every figure below is derived from the code's own constants or from a published provider limit, and says
which. Nothing here was measured against the production account: Turso's usage dashboard and the
production database were not readable from the session that wrote this (the database credentials are
write-only Vercel variables). The first canary scans are what turn this model into a measurement (see
"What to measure").

## Inputs

| Input | Value | Source |
| --- | --- | --- |
| Detection runs/day | 96 (`*/15 * * * *`), plus the daily Vercel GET | plan |
| Tokens per scan | at most 30 | `lib/market.ts` discovery cap |
| Same-mint repeat collapse | one signal per (model, mint, state) per 6 h bucket | `SIGNAL_BUCKET_MS` |
| Outcome rows per signal | 3 (d1, d3, d7) | `ACTIVE_HORIZONS` |
| Stored bytes per signal | ~3.0-3.1 KB JSON measured on fixtures; **4 KB** planning figure incl. columns, indexes, 3 outcome rows, cached social evidence | measured locally |
| Settlement capacity | 1,200 distinct pools per daily run (40 requests x 30) | `MAX_OUTCOME_BATCHES` (this PR) |
| Backtest read | newest 2,000 signals | `MAX_RETAINED_SIGNALS` |
| Turso Free | 5 GB storage, 500 M rows read/month, 10 M rows written/month; queries fail with `BLOCKED` past a quota unless overages are enabled | turso.tech/pricing, docs.turso.tech (2026-09-29) |
| DEX Screener | 300 req/min on pair/token endpoints, 60 req/min on profiles/boosts | docs.dexscreener.com |
| RugCheck | **unpublished** unauthenticated limit; 12 checks/scan cap, 20 s budget, 30 min persisted cooldown after a 429 | `lib/goldmine/contract-safety.ts` |

## Scenarios

`N` = new signals recorded per day. Every scanned token with a price is recorded, REJECTED controls
included, so N is set by how many *distinct* mints discovery returns across the day. The six-hour
bucket only collapses repeats of the same mint in the same state.

| | Repeated-mint overlap (same ~30 mints all day) | Worst case (30 new mints every run) |
| --- | --- | --- |
| N signals/day | 30 x 4 buckets = **120** (+ state changes) | 96 x 30 = **2,880** |
| Outcome rows created/day | 360 | 8,640 |
| Rows written/day (signal + 3 outcomes + 3 settlements + ~2 lock/cooldown writes per run) | ~1.0 k | ~20.3 k |
| Rows written/month | ~30 k (0.3% of 10 M) | ~0.6 M (6%; 12% if index writes are billed too) |
| Storage growth | ~0.5 MB/day, ~14 MB/30 days | ~11.5 MB/day, ~350 MB/30 days, ~4.2 GB/year |
| Settlement demand (pools due per daily run, ~3 x distinct pairs/day) | ~90-360 | ~8,640 |
| Fits 1,200/run settlement? | yes | **no** (outcomes beyond the cap are deferred, then missed when their window closes) |
| Days of history in the 2,000-row backtest read | ~16 | ~0.7 |

### Rows read

- **Per detection (the 96/day path): flat, independent of history size.** `tests/capacity-query-plans.test.mjs`
  runs a real detection POST against 3,000 stored signals and asserts that every statement it issues uses
  a key or index lookup on `goldmine_signals`/`goldmine_outcomes`, never a table scan. That is roughly 100-200
  rows per invocation (30 social-cache keys, 30 signal PK checks, 30 outcome inserts, lock and cooldown rows),
  about 0.6 M rows/month.
- **Daily settlement:** a range over the pending-outcome index (also asserted to be no full scan), at most
  ~70 k rows in the worst case, about 2 M/month.
- **Dashboard and backtest loads: grow with all stored history.** `readSignalTotals` (all-history counts)
  and `readTracking`'s stats aggregate scan every signal/outcome. The test lists them exactly. A load at T days
  of worst-case history reads about 20 k x T rows: ~0.6 M at 30 days, ~1.8 M at 90 days, ~7 M at a year.
  Against 500 M/month, the worst case therefore allows ~800 page loads/month at 30 days but only ~70/month
  after a year. At the overlap scenario everything is 24x smaller. This is an owner-driven cost, not a
  cadence-driven one, but with no retention it keeps growing. It is the first thing to revisit if measured
  volume is near the worst case.

## Answers

1. **Per-invocation provider and database cost fits with a wide margin in both scenarios.** Detection is
   ~0.1% of the DEX Screener limits, ~0.6 M Turso reads and <=0.6 M writes/month.
2. **Outcome settlement was the binding constraint**, not storage. At 150 pools/run (before this PR), anything
   above ~50 distinct pairs/day would start losing d1/d3/d7 observations. At 1,200/run the sustainable rate is
   **~400 distinct pairs/day**. The activation gate uses 300/day for margin. The worst case (2,880/day) does not
   fit, and no cap that one daily function run can safely settle would make it fit.
3. **The 30-day research window.** Storing 30 days fits easily (<=350 MB worst case of 5 GB), and nothing is
   pruned. *Analyzing* 30 days in one backtest read does not fit the 2,000-row bound at a 15-minute cadence
   unless fewer than ~67 signals/day are recorded. The safe answer implemented now is honest disclosure: the
   backtest states exactly which detection-time window it covers and whether the 30-day target was reached
   (PR #26), so it never reads as "30 days" or "all history". An archive/export or a larger, archive-aware read
   is future work. It would need its own verifiable export and recovery tests first. No production data is
   deleted or pruned by any of this.

## What to measure before 15-minute activation

Each scheduled invocation now logs `coin_radar.scan_outcome` with `newSignals`, `durationMs` and the
contract-safety block. The canary (bounded, detection-only POSTs) and the first lower-frequency trigger runs
give:

- **new signals per run -> N/day.** The gate: projected distinct pairs/day <= 300. This is an upper bound on
  distinct pairs, since `newSignals` also counts state changes of known mints. Above 300 is a **NO-GO for
  15 minutes**; keep a lower cadence at which the measured rate fits.
- **durationMs** well under the 300 s function limit and lock lease.
- **safety coverage:** `requests`, `rateLimited`, `cooldown`. Sustained 429s mean the cooldown is suppressing
  most checks, so opportunities fail closed and the cadence gains nothing.
- **Turso dashboard** rows read/written and storage, compared with the scenario the measured N implies.
