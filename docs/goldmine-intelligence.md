# Goldmine Intelligence

For maintainers and reviewers of Coin Radar. This describes the Stage 03A foundation as implemented, the rules of Momentum Score v2, and the planned Stage 03 sequence. Goldmine produces research signals from provider snapshots. It does not trade, size positions or predict prices, and nothing in it implies a profit.

## 1. Pipeline

```
DEX Screener discovery (lib/market.ts discoverSolanaPairs, shared with GET /api/market)
  -> CandidateSnapshot per token, highest-liquidity pool   (lib/goldmine/snapshot.ts)
  -> + cached public X evidence from social_cache           (no X request)
  -> Assessment: components, gates, state, opportunity      (lib/goldmine/score.ts, pure)
  -> goldmine_signals + goldmine_outcomes                   (lib/goldmine/signals.ts)
```

`POST /api/goldmine` (signed in, same origin, one shared lock `goldmine:scan`) first settles due outcomes, then discovers, scores, attaches contract safety (lib/goldmine/contract-safety.ts, Stage 03B) for actionable candidates, then re-scores and records. `GET /api/goldmine` reads recent signals and statistics. Without a working `DB` binding - D1 on Sites, or Turso on Vercel when `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` are unset (docs/deployment-runbook.md) - both answer 503 before any provider call.

## 2. Candidate snapshot

One token's best pool at one moment: price, liquidity, market cap, FDV, pool creation time and age, volume, buy and sell counts and price change for 5m/1h/6h/24h, paid promotion, link counts, cached social evidence and contract safety.

- A value that is missing, non-finite, negative, a non-integer count, a price change below -100%, or a pool timestamp more than five minutes in the future is `null`. Scoring treats `null` as missing evidence, never as zero.
- `contractSafety` starts as `{status: 'unavailable'}` from `snapshotFromPair`, never from the DEX Screener pair itself. `attachContractSafety`/`withContractSafety` (lib/goldmine/contract-safety.ts) fill it in afterward, from RugCheck, for candidates that already cleared every hard gate. See section 3b.
- The snapshot is stored with every signal, so a later model version can re-score exactly what was observed.

## 3. Momentum Score v2 (`momentum-v2.1.0`)

Deterministic: the assessment depends only on the snapshot, never on the clock. Any change to a rule or threshold must change `MODEL_VERSION`. v2.1.0 replaced v2.0.0, whose safety component granted points up front and only deducted observed risks, so a missing risk input could raise a score or unlock an entry state.

| Component | Max | Points |
| --- | --- | --- |
| Liquidity and genuine volume | 20 | Liquidity ≥$250k 12, ≥$100k 10, ≥$50k 7, ≥$25k 4. 24h volume ≥$50k +4. Turnover (24h volume / liquidity) within 0.5x-30x +4. |
| Volume acceleration | 20 | Needs ≥20 last-hour swaps. 1h volume vs the 6h hourly average: ≥3x 12, ≥2x 9, ≥1.3x 6, ≥1x 3. 5m pace vs 1h: ≥1.5x 8, ≥1x 4. |
| Buyer growth and buy/sell balance | 20 | Needs ≥20 last-hour swaps. Buy share 55-80% 10, 50-55% 5, above 80% 4 (one-sided). 1h buys vs the 6h hourly average: ≥2x 10, ≥1.3x 6, ≥1x 3. Counts are swaps, not unique wallets. |
| Token age and valuation | 15 | Age <1h 2, <6h 5, <72h 8, <30d 6, older 3. Valuation needs both market cap and FDV (to check dilution): market cap <$100k 2, <$1M 7, <$10M 5, <$50M 3, larger 1; none if FDV exceeds 5x market cap. |
| Social momentum | 10 | Only cached X evidence at most 6 hours old, with at least 5 posts: ≥10 distinct authors 6, ≥5 3; repeated text <20% 4, <40% 2. Zero for promoted tokens. Project links never count. |
| Safety risk | 15 | Starts at 0. Verified contract safety +7. Each market risk check earns its points only when its input is present and passes: 1h rise at most 50% +2; 24h fall at most 30% +1; turnover at most 30x +1; buy share at most 80% +1; FDV at most 5x market cap +1; valuation at most 100x liquidity +1; pool at least 1h old +1. A failed check is a listed risk; a missing input is unassessed and earns nothing. |

Every component lists its evidence. Points come only from inputs that are present and pass. The tests remove every single input and every pair of inputs from reference and risky candidates, with and without verified contract safety, and require that the score never rises, a risk or rejected state never becomes an entry state, and no opportunity appears.

### Hard gates (state `REJECTED`)

| Gate | Category | Condition |
| --- | --- | --- |
| `missing_price`, `missing_liquidity`, `missing_pool_age`, `missing_activity`, `missing_volume` | data | Price, liquidity, pool age, last-hour buy/sell counts or 24h volume unavailable |
| `missing_price_change` | data | The 5m, 1h or 24h price change is unavailable, so overheating cannot be ruled out |
| `insufficient_history` | data | Pool younger than 15 minutes |
| `thin_liquidity` | safety | Liquidity below $25,000 |
| `sells_absent` | safety | ≥20 buys and no sells in the last hour (honeypot pattern) |
| `price_collapse` | safety | ≤-40% in 1h or ≤-60% in 24h |
| `extreme_turnover` | manipulation | 24h volume above 100x liquidity |
| `no_qualifying_momentum` | momentum | Passes every gate but matches no state below |

### States (first match wins)

1. `OVERHEATED`: 1h ≥+50%, 24h ≥+300% or 5m ≥+20%.
2. `DISTRIBUTION`: buy share ≤45% while the 1h price change is negative.
3. `BREAKOUT`: 1h ≥+10%, acceleration ≥2x, buy share ≥55%, liquidity ≥$50k.
4. `EARLY`: pool younger than 6h, buy share ≥50%, 1h change ≥0.
5. `BUILDING`: acceleration ≥1x, buy share ≥50%, 1h change ≥0.

States describe the snapshot. They are not predictions.

### Opportunity status

A candidate is an opportunity only if it is `EARLY`, `BUILDING` or `BREAKOUT`, scores at least 60, has every market risk check assessed (`risk_inputs_incomplete` otherwise), and has verified contract safety. Each unmet condition is a listed blocker. As of Stage 03A, no provider supplied contract safety, so no candidate could be an opportunity; that was intentional fail-closed behavior, not a defect, and stays the default for any candidate RugCheck cannot verify (section 3b).

## 3b. Contract safety (Stage 03B, RugCheck)

`lib/goldmine/contract-safety.ts` calls RugCheck's public, unauthenticated `GET /v1/tokens/{mint}/report` (no API key, no write endpoint, no wallet action; `/report/summary` was considered but omits mint/freeze authority, holders, creator and insider fields entirely). Only candidates that already cleared every hard gate are checked (`withContractSafety`) — a `REJECTED` candidate never depends on contract safety, so it never costs a request. Requests run one at a time, never in parallel, with an 8-second timeout and no retry; a fetched report is cached in memory for 10 minutes per mint, well inside RugCheck's observed unauthenticated rate limit (~15 requests per window), and the first `429` stops every further request for the rest of that scan. A single scan can surface up to 30 actionable candidates (lib/market.ts's discovery cap), so `attachContractSafety` also enforces its own ceiling regardless of 429s: at most `MAX_CHECKS_PER_SCAN` (12) requests, and no more once `SCAN_BUDGET_MS` (20s) of real wall-clock time has passed — both chosen to keep this stage from running past `goldmine:scan`'s own 300-second lock (`SCAN_LOCK_TTL_MS`, lib/goldmine/scan.ts), which would let a second scan start concurrently. Candidates beyond either limit simply keep their existing (`unavailable`) contractSafety, the same predictable fail-closed outcome as a 429.

RugCheck's own score or verdict is never read. Instead its facts feed our own deterministic checks (`deriveContractSafety`), each independently available or not:

| Check | Bar |
| --- | --- |
| Mint authority | Renounced (`null`) |
| Freeze authority | Renounced (`null`) |
| LP locked | At least 80%, liquidity-weighted across every reported market (not just the largest — a smaller, materially unlocked market is never hidden by a well-locked bigger one) |
| Holder concentration | Largest holder at most 20% of supply; reported top holders sum to at most 50% (entries are merged by owner first, so one wallet split across several token accounts is counted once) |
| Creator holdings | At most 10% of supply |
| Insider network | None detected |
| Rugged | Not flagged rugged |
| Provider risks | No `danger`-level entry in RugCheck's own `risks` |

`contractSafety` is one of three states, kept distinguishable in the stored snapshot: `unavailable` (no usable report, RugCheck error, malformed or schema-drifted response, a report older than 15 minutes, or one missing a required fact), `unsafe` (a report was obtained and at least one available check failed — `facts` and `failedChecks` are kept for provenance), or `verified` (every check available and passed). Only `verified` earns the score's +7 safety points and clears the `contract_safety_unverified` blocker; `unsafe` and `unavailable` are both "not verified" to the opportunity gate, exactly as before Stage 03B.

## 3c. Backtesting and calibration (Stage 03D)

`GET /api/goldmine/backtest` (signed in, read-only) is a diagnostic over already-stored `goldmine_signals`/`goldmine_outcomes` rows (`lib/goldmine/backtest.ts`, `lib/goldmine/signals.ts` `readAllSignalsWithOutcomes`). It makes no provider request, never writes to storage and never changes live scoring: `lib/goldmine/score.ts` is only called to recompute an assessment from a stored snapshot for comparison, never to overwrite anything. It reads every stored signal, not just the last 50 `GET /api/goldmine` shows, and across every stored `model_version`, not just the current one.

- **Reading, bounds and worst-case cost.** Signals are read in fixed, keyset-paginated pages (`SIGNAL_READ_BATCH_SIZE` = 200, ordered by `(detected_at, id)` **descending** so a page boundary is stable even between rows sharing a `detected_at` and, when the read is bounded, the *newest* signals are the ones kept), never as one unbounded query or a single `json_each(?)` bind of every id ever recorded; outcome lookups are likewise batched by id (`OUTCOME_ID_BATCH_SIZE` = 200). A hard cap on pages per request (`MAX_SIGNAL_READ_BATCHES` = 10, so `MAX_RETAINED_SIGNALS` = 2,000) makes the read bounded even against an unbounded table - if reached, the response's `truncated: true` says so honestly rather than silently reporting a partial history as complete, and the collected pages (newest-first) are reversed back to ascending order before any other module sees them, so replay/performance/calibration behave exactly as before. Each page is fetched with a one-row lookahead (`LIMIT signalBatchSize + 1`): if the extra row comes back, more history exists beyond this page (or this is the exact-cap case, which now correctly reports `truncated: false` when history ends exactly at the cap, and `true` only when at least one more row exists past it). **Worst-case D1 query count** for one request: `MAX_SIGNAL_READ_BATCHES` signal pages (10) + `ceil(MAX_RETAINED_SIGNALS / OUTCOME_ID_BATCH_SIZE)` outcome-id batches (10) = **20 queries**, independent of how much history is actually stored - chosen without assuming a paid Cloudflare plan, to leave wide margin below any conservative per-invocation query ceiling a Workers Free plan could impose. **Worst-case retained data**: at the cap, 2,000 signal rows (each a full snapshot + assessment, ~4 KB of JSON per row) plus their outcome rows - three per newly recorded signal (the active horizons) and four for a signal recorded under the legacy intraday schedule, so at most 2,000 × 4 = 8,000, which is the bound the measurements below were taken against. Two separate, non-interchangeable numbers back the claim that this stays well within a Workers isolate's 128 MB memory limit: (1) a deterministic, CI-committed test (`tests/goldmine-backtest-limits.test.mjs`) asserts the **serialized JSON text size** of a maximal synthetic dataset stays under 30 MB - this is an exact, reproducible fixture-size check, not a heap measurement; (2) a separate, one-off **diagnostic Node heap observation** (`--expose-gc`, not committed as a test, not run in CI - a heap assertion would be flaky under normal GC timing) measured approximately 16.4 MB of actual retained heap for a comparable dataset with RugCheck facts and risks populated. Neither number is a measurement of a Cloudflare Workers V8 isolate's actual memory use: Node's V8 and a Workers isolate's V8 have different baseline and per-object overhead, so neither is formal proof of peak Workers memory. Both leave a wide margin below the 128 MB limit, which is the basis for treating the cap as safe. No retention or deletion is implemented; stored history still grows without bound over time, and a deployment with more signals than this cap covers will see `truncated: true` until an archival policy exists (out of scope here).
- **Validation.** A row whose stored `snapshot`/`assessment` JSON is missing, corrupt, or structurally not a real `CandidateSnapshot`/`Assessment` is skipped and counted in `skippedMalformedRows`, never guessed at, never allowed to reach `scoreCandidate` with a shape it cannot safely process. `isValidStoredSnapshot` rejects `[]`, `{}`, `null`, wrong-typed fields, missing nested fields, any negative amount (liquidity, market cap, FDV, volume, transaction counts, age), and validates `contractSafety` as its real discriminated union - `unavailable`/`unsafe`/`verified` only, with `unsafe` requiring a non-empty string-array `failedChecks` and both `unsafe`/`verified` requiring a valid `source`/`checkedAt`/`facts`. `isValidStoredAssessment` rejects an unrecognized `state` (must be one of `STATES`) and a `score` outside `[0, 100]` (the real domain `scoreCandidate` can ever produce), alongside the previous shape checks. The row's own `model_version`/`state` columns are cross-checked against the parsed assessment's `modelVersion`/`state`; a mismatch is treated as malformed (replay/filtering read the column, calibration reads the assessment's content, so a disagreement between them must never enter either). `detected_price` must be a finite, positive number (every return computation divides by it). As defense-in-depth beyond structural validation, `replaySignal` also wraps its `scoreCandidate` call: an unanticipated bad row that still makes it throw is skipped and counted (`replay.invalidCount`) rather than turning the whole request into a 503 for every other signal. Unlike an *expected* validation outcome (e.g. an unsupported model version, counted quietly), this unanticipated exception is also reported through the same redacted diagnostics mechanism every other route uses (`lib/diagnostics.ts`, operation `backtest-replay`, level `warn`) - bounded to at most `MAX_REPLAY_EXCEPTION_DIAGNOSTICS` (5) diagnostics per request regardless of how many rows fail this way, so a large corrupted history can never emit one log line per row; `replay.invalidCount` itself stays the true, unbounded total. A genuine storage failure (a rejected D1 query) is reported separately (operation `backtest`, the route's own catch) and still fails the whole request rather than being counted as a malformed row - the two are never conflated.
- **Outcome validation.** A stored outcome row is validated against exactly the shape `evaluateOutcomes` ever writes: a known horizon, a known status (`pending`/`observed`/`unavailable`/`missed`), and status-appropriate nullability of `observed_at`/`price`/`liquidity` (e.g. `observed` requires a finite positive `price`). An unrecognized status string (a corrupt or hand-edited row, e.g. `'CORRUPT'` or `'Observed'`) is never reinterpreted as `pending` - that would silently inflate pending coverage and hide the corruption. It is excluded from coverage/returns and counted separately in `skippedMalformedOutcomes`.
- **Historical replay.** `scoreCandidate` is a pure function of the stored snapshot, so for a signal whose stored `model_version` equals the current `MODEL_VERSION`, recomputing it must reproduce the stored assessment exactly (`replaySignal`/`replayAll`); a mismatch would mean scoring drifted from what was recorded, or the stored row was tampered with. This is the only model version this codebase implements. A signal from any other stored `model_version` has no implementation to replay it with here: it is never run through the current `scoreCandidate` and relabeled as its historical result. It is reported as unsupported, with the original stored assessment as its only record - a mechanism that extends without rework once a v2.2.0+ exists. `replay.mismatchedSample` is a small, deterministic, bounded sample (`MISMATCHED_SAMPLE_LIMIT` = 20) of mismatched signal ids/addresses, never an unbounded list; `replay.mismatchedCount` is always the true total and `replay.mismatchedSampleTruncated` says whether the sample is a subset of it.
- **Performance analysis.** `performanceReport` groups every stored outcome by model version x signal state x horizon - the active `d1`/`d3`/`d7` targets and the legacy `15m`/`1h`/`6h`/`24h` ids still present in history (section 4b) - and reports, per bucket: the horizon's own schedule, whether the current cadence can observe it at all, outcome coverage (`pending`/`expired-unswept`/`observed`/`unavailable`/`missed` counts - every derived state counted, none dropped from the denominator or read as a zero return), the distribution of *actual* elapsed hours between detection and observation, and, over `observed` outcomes only, a return distribution (count, mean, median, sample standard deviation - `stdev` is `null`, not zero, below two observations, and a mean at `n=1` is a single data point, not a statistic; the dashboard marks it explicitly). A bucket with mostly `pending`/`unavailable`/`missed` coverage has little realized evidence regardless of what its handful of `observed` outcomes show; the coverage counts are reported specifically so that is visible, not hidden behind a mean. The dashboard table always shows a Model column alongside state and horizon, so rows from different model versions can never look identical.
- **Calibration and per-cell evidence.** `calibrationSweep` asks "what would the opportunity set and its outcomes have looked like at a different `OPPORTUNITY_MIN_SCORE`" without reading or changing the real threshold (60) in `lib/goldmine/score.ts`. It is restricted to the current `MODEL_VERSION` only (exposed as `calibration.modelVersion`): signals from any other stored `model_version` are excluded, never reinterpreted under these thresholds or blocker rules, and the exclusion is reported transparently as `calibration.excludedOtherVersionSignals` rather than silently. For each of a fixed set of candidate thresholds (40/50/60/70/80/90 - never chosen or searched for to fit the data), `wouldBeOpportunityAt` re-applies only the score gate to each stored assessment's already-decided state and other blockers. To avoid drawing a conclusion from the same data used to state it, stored signals are split chronologically at their median `detected_at`: the earlier ("reference") half is never scored or reported; only the later ("evaluation") half's outcomes are reported per threshold. **Every threshold/horizon cell carries its own `cellStatus`** (`'sufficient' | 'insufficient' | 'not_evaluable'`), computed only from that cell's own usable observed returns (`returnsPct.count` - the values `distribution()` actually computed over, not `coverage.observed`, which can exceed it when an `'observed'` outcome's price could not produce a finite return): `not_evaluable` when `eligible === 0`, `sufficient` once at least `MIN_OBSERVED_RETURN_SAMPLES` (20) usable returns exist, `insufficient` otherwise. A populated 15m cell never lends credibility to a weak or not-evaluable 1h/6h/24h cell, or to a different threshold row. `CalibrationResult` exposes exact reconciliation counts - `sufficientCellCount + insufficientCellCount + notEvaluableCellCount === totalCellCount` always. `descriptiveOnly` is `true` unless there is at least one evaluable cell, **every** evaluable cell is individually `sufficient` (`insufficientCellCount === 0`), and the evaluation half itself has reached `MIN_EVALUATION_SIGNALS` (20) - a single sufficient cell can never flip this to `false` while any other evaluable cell remains insufficient. Rows are still returned in full for visibility whenever `descriptiveOnly` is `true`, never withheld.
- **Dashboard.** `app/goldmine-panel.tsx`'s "Backtesting & calibration" section (view logic in `lib/goldmine/backtest-view.ts`) fetches this endpoint and shows the replay summary, the per-bucket performance table (with its Model column) and the threshold sweep (labeled with the single calibrated model version, any excluded other-version signal count, and the sufficient/insufficient/not-evaluable cell reconciliation) only once at least `MIN_SIGNALS_FOR_REPORT` (10) signals are recorded; below that it says so plainly instead of rendering a report built from a handful of rows. A data-quality banner (`hasDataQualityWarning`/`dataQualityWarning`) is shown whenever the read was truncated or any row/outcome was excluded for failing validation - it states explicitly that the analysis is partial, how many rows were analyzed, whether malformed data was excluded (and how much), and that a truncated read reflects only the most recently detected signals, never an unqualified "N signals recorded" that could be mistaken for the complete history. Each calibration cell that is not `sufficient` is labeled inline (`cellStatusLabel`) as "insufficient evidence" or "no eligible signals".

  Since Stage 06 the same section also makes the cadence facts unavoidable, and these are rendered whenever the section renders - deliberately including the "not enough recorded signals yet" case, which is exactly when "why is everything missed?" is asked: the once-daily cadence and what a daily-snapshot target means (`cadenceSummary`); the legacy intraday horizons named as unevaluable under it, with the reason (`legacyHorizonWarning`, derived from each horizon's own window, never a hardcoded id list); a Schedule column and an Observed column per performance row, so a legacy bucket's coverage is never read as a result and an observed return always carries its real elapsed time (`horizonScheduleNote`, `observedAfterLabel`); expired-unswept counts named as a closed window rather than live pending work (`coverageLabel`); the all-history opportunity count, with zero stated plainly as a result (`allHistoryOpportunityLabel`); and the separate control and strategy denominators with an explicit statement that a REJECTED observation says nothing about the candidates that cleared every gate (`denominatorNote`). The calibration table's horizon columns come from the report's own horizons, never a hardcoded list, so a legacy column can never be mislabeled as an active one. It is read-only: it changes nothing, triggers no scan, and never rewrites an expired-unswept row. Its tables scroll inside their own container rather than widening the page, checked down to a 320px viewport.
- **What this is not.** A research/diagnostic tool over historical detections, not a forecast: nothing here estimates or claims predictive accuracy or profitability, in the API, the dashboard or this document. Samples are not statistically independent - the same token can recur across scans, and one signal contributes to every one of its horizon buckets at once (three under the active schedule, four under the legacy one) - so every mean/median/stdev here describes this recorded history, not an estimate from independent trials. It is also not a step toward paper or real-money trading: see section 4b, "What this stage does not do". See section 7 for the same discovery-coverage and price-quote limitations that already apply to every signal this reads.

## 4. Signal tracking

- A signal is recorded for each priced candidate, including rejected ones (for gate evaluation later), at most once per model version, token, state and six-hour UTC bucket. It stores the detection price, the snapshot and the assessment. It holds no user data and every signed-in user reads the same signals.
- Each **new** signal gets outcomes at the three **active** horizons (`lib/goldmine/cadence.ts` `ACTIVE_HORIZONS`): `d1` (1-day target), `d3` (3-day target) and `d7` (7-day target). Each has a 26-hour post-target grace window, so a signal's outcome window is `[detected + target, detected + target + 26h]`. An outcome is evaluated only inside that window:
  - `observed`: the recorded pool returned a valid price (and liquidity when available);
  - `unavailable`: the provider answered without the pool or its price (possibly delisted);
  - `missed`: no scan ran inside the window. A later price is never recorded as the horizon's price;
  - a provider failure leaves the outcome pending for the next scan.
- Outcomes are **not** settled at exact 24h/72h/168h. Each is "the first daily snapshot at or after the target age". `observed_at` is stored and exposed, and every read path reports the **actual elapsed time** between detection and observation (`observedAfterHours`). Section 4b explains why that distinction is not cosmetic.
- Due outcomes are grouped by recorded pool and read in batches of at most 30 pools, earliest-closing window first (then pool and token), with at most 5 requests per scan, sent in parallel. A failed batch leaves only its own outcomes pending; pools beyond the cap are reported as `deferred` and read by the next scan while their windows are open.
- Evaluation runs only when someone scans, so without a scheduler many outcomes will be `missed`. Prices are provider quotes, not executable prices; returns ignore fees, slippage and liquidity.

### 4b. Cadence-honest outcome evaluation (Stage 06)

Everything in this subsection is derived in one place, `lib/goldmine/cadence.ts`. The API, the database writer, the dashboard and the tests all read it from there; no cadence number is restated anywhere else.

**The scheduler this deployment actually has.** `vercel.json` runs `GET /api/goldmine/scheduled` on `0 0 * * *`: once a day, and on the Hobby plan only to the nearest hour, so an invocation lands somewhere in 00:00-00:59 UTC. That gives:

| Constant | Value | Where it comes from |
| --- | --- | --- |
| `SCAN_CADENCE_MS` | 24 h | the deployed cron expression |
| `SCHEDULER_JITTER_MS` | 59 min | Hobby fires inside its scheduled hour |
| `MAX_SCAN_GAP_MS` | 24 h 59 min | derived: cadence + jitter (a maximally-late run after a maximally-early one) |
| `MIN_SCAN_GAP_MS` | 23 h 01 min | derived: cadence - jitter |
| `OBSERVATION_GRACE_MS` | 26 h | every active horizon's post-target window |
| `OBSERVATION_GRACE_BUFFER_MS` | 61 min | derived: grace - max gap; must stay positive |

**Why a horizon is observable, and what the invariant actually is.** A signal's `detected_at` *is* a scan's timestamp (`lib/goldmine/scan.ts` passes one `now` to both `evaluateOutcomes` and `recordSignals`), so detection coincides with a scan `s(0)`. Let later scans be `s(1) < s(2) < …` with every gap at most `MAX_SCAN_GAP_MS`, and let `T = s(0) + target`. There is a least `j` with `s(j) >= T`; that `j` is at least 1, so `s(j-1)` exists and `s(j-1) < T` by minimality, hence `s(j) <= s(j-1) + MAX_SCAN_GAP_MS < T + MAX_SCAN_GAP_MS <= T + 26h`. So `s(j)` falls inside `[T, T + 26h]`, which is exactly the window `evaluateOutcomes` settles inside (`due_at <= now AND deadline_at >= now`).

The invariant is therefore **`window >= MAX_SCAN_GAP_MS`** and nothing else - the width of the observation window. It is *not* `target + window >= cadence × 1.25`, which an earlier draft proposed: that formula says nothing about whether a scan is *phased* to land in the window. `tests/goldmine-cadence.test.mjs` refutes it in both directions with concrete schedules - a 100-hour target with a one-minute window passes the rejected formula and is provably missed by exact daily scans, while a one-minute target with a 26-hour window fails it and is provably always observed.

**Why the actual elapsed observation time matters, and is always reported.** Every active target is an exact multiple of the cadence, so the target lands on a scheduling boundary. The scan nominally due at the target is early (by up to 59 minutes) roughly as often as it is late, and an early scan does not qualify - it arrives before `due_at`. The next daily scan then settles the outcome about a full day later. A `d1` observation is therefore legitimately either near 24 hours or near 48 hours old, and nothing about the horizon's id can tell those apart. So:

- `observed_at` is stored and exposed, never discarded;
- `GET /api/goldmine` reports `observedAfterHours` per outcome and a mean per state/horizon;
- `GET /api/goldmine/backtest` reports an `observedAfterHours` distribution beside every return distribution, computed from the same outcomes;
- the dashboard prints "+4.2% after 47.2h" and "47.2h after detection", and the user-facing wording is "1-day target, observed at the next daily snapshot" - never an exact-return claim.

Read the elapsed time, not the horizon name, as the holding period a return describes.

**Legacy horizons: why they are still here.** Stored history contains 348 outcome rows under four legacy ids - `15m`, `1h`, `6h` and `24h` - written by an intraday schedule sized for five-minute scanning that this deployment never ran. They are kept in `LEGACY_HORIZONS` with exactly their original `after`/`window`, and `isValidStoredOutcomeRow` still accepts them, because:

- a stored row's `deadline_at` only reconciles against the definition it was written under;
- removing them would make every historical row fail validation, so it would vanish from coverage reporting into `skippedMalformedOutcomes` - deleting the evidence rather than explaining it;
- the dashboard has to be able to say *why* they cannot be evaluated, which needs their real window.

**None of the four can be evaluated by a once-daily scan**, including the two the earlier version of this document got wrong:

| Legacy horizon | Target | Window | Why it cannot settle |
| --- | --- | --- | --- |
| `15m` | 15 min | 5 min | window ≪ max scan gap; opens and closes between two scans |
| `1h` | 1 h | 15 min | same |
| `6h` | 6 h | 1 h | same - **previously omitted** from this document, which named only 15m and 1h |
| `24h` | 24 h | 3 h | the subtle one: its 3-hour window is narrower than the 24 h 59 min maximum gap, so whether it ever settled depended on where cron drift happened to put the next scan. It sometimes worked, by luck, not by design - **previously described as if it settled normally** |

Nothing ever writes a legacy id again: `recordSignals` iterates `ACTIVE_HORIZONS` only.

**Evaluation-schedule versioning, without a migration.** `EVALUATION_SCHEDULE_VERSION` (`daily-snapshot-v1`) versions *when outcomes are observed*; `MODEL_VERSION` (`momentum-v2.1.0`) versions *how a candidate is scored*. They are deliberately separate, and Stage 06 changed only the former - scoring is untouched. Per-row versioning needs no new column and no migration, because the two id sets are disjoint and only the active set is ever written: a `d1` row can only have come from `daily-snapshot-v1`, a `24h` row only from `intraday-v0`. The horizon id *is* the truthful per-row schedule record, and the API derives `horizonSchedule` from it.

**Honest pending, and `expired_unswept`.** A pending row whose window has closed is only rewritten to `missed` by a scan. Between the window closing and the next scan the stored status still reads `pending`, which would overstate how much evidence is still coming. Read paths therefore derive a state from `(status, deadline_at, read timestamp)`:

| Derived state | Meaning |
| --- | --- |
| `pending` | genuinely still inside its observation window |
| `expired_unswept` | window closed, no scan has swept it yet - **not** live pending work, and **not** a claim that it was missed |
| `observed` / `unavailable` / `missed` | the stored, settled status |

`expired_unswept` is **not** a stored status (`OUTCOME_STATUSES` still has exactly four), and opening the dashboard never writes a row: the derivation uses `deadline_at < now`, the same predicate `evaluateOutcomes` sweeps with, so a read and a scan always agree about which rows are still live. Coverage counts all five states separately and they always reconcile to the number of valid rows in the bucket.

**Why REJECTED signals are retained as a control group.** A signal is recorded for every priced candidate, rejected ones included. Without them there is nothing to compare an actionable-state result against: "BREAKOUT returned +4% on average" means nothing unless the candidates the model deliberately refused are also measured. But a REJECTED observation is a *control measurement*, never evidence about the strategy, so the report keeps three separate denominators (`denominators.control`, `.strategy`, `.opportunity`) and never sums them. `control` and `strategy` partition the signals exactly (REJECTED or not); `opportunity` is nested inside `strategy`. The dashboard states this in words next to the numbers, and labels the REJECTED rows in the performance table as the control group.

**All-history counts.** `readSignalTotals` is a separate single `COUNT` query, not a count over the bounded page-by-page read, because that read is capped at `MAX_RETAINED_SIGNALS` and can report `truncated`. "0 opportunities across all 87 recorded signals" is a result the dashboard states plainly - "nothing has ever cleared every safety and momentum gate on this deployment. That is a result, not missing data."

**What this stage does not do.** It makes the outcome evidence honest and measurable. It does not make it good, and it creates no validated strategy. In particular it does not bring the product any closer to paper or real-money trading: the detection price is still a DEX Screener quote rather than an executable one, returns still ignore fees, slippage and price impact, discovery still samples at most 30 profiled or promoted tokens once a day, samples are still not independent, and a daily snapshot is not an execution price at any horizon. A more honest measurement of a strategy that has not been shown to work is still not a reason to trade it.

### The most recent recorded batch (`GET /api/goldmine` → `latest`)

Every signal one scan writes carries that scan's single `detected_at` (`recordSignals()` binds one value for the whole batch), so the rows holding `MAX(detected_at)` are exactly what the most recent scan that recorded anything recorded. `readLatestBatch()` (`lib/goldmine/signals.ts`) reads them with one grouped, index-backed `SELECT` and returns `{detectedAt, signalCount, opportunityCount, byState[]}`, or `null` when the table is empty. No new column, table or migration is involved.

This exists because the dashboard panel's scan status is session-scoped: it reflects the `POST /api/goldmine` this browser tab ran, and nothing else. On the Vercel+Turso deployment the scan that matters most runs unattended once a day (Vercel Cron, see Scheduled scans below), and before `latest` the panel could not show that it had happened, what it scored, or that it had found nothing actionable - a working scheduler and a broken one rendered the same empty panel. `latest` is the one storage-backed thing the panel shows on load.

Two limits are deliberate, stated in the UI copy rather than papered over, and asserted in `tests/goldmine-dashboard-view.test.mjs`:

- **It is not "when the last scan ran".** A scan that records nothing still ran: every candidate may already be recorded in the same state and six-hour bucket (`signalId()`), or discovery may have failed and returned `provider_unavailable`. `detected_at` does not advance in either case, so the panel says *recorded*, never *scanned*.
- **It does not say who scanned.** The interactive `POST /api/goldmine` and the scheduled route write identical rows through the same pipeline; nothing stored distinguishes them.

Model version is not filtered, unlike `readTracking()`'s statistics, so a model change can never make the dashboard look as though scanning had stopped. The panel calls the gap out only past 26 hours (`BATCH_OVERDUE_AFTER_MS` in `lib/goldmine/dashboard-view.ts`), which clears the daily schedule plus the Hobby plan's up-to-59-minute timing drift, and the note names the threshold instead of asserting a cause it cannot observe.

### Scheduled scans

`app/api/goldmine/scheduled/route.ts` (`GET` and `POST`, both run `lib/goldmine/scan.ts`'s `runGoldmineScan`, the same pipeline and the same shared `goldmine:scan` lock as the interactive `POST /api/goldmine`) is the unattended entry point. There is no signed-in user and no browser origin for a scheduler, so it never uses `getChatGPTUser()`/`sameOrigin()`; authorization is entirely `lib/goldmine/scheduled-auth.ts`'s shared-secret check, which accepts either:

- `x-goldmine-cron-secret: <GOLDMINE_CRON_SECRET>` - a custom header, for any scheduler that can set an arbitrary header (a future Cloudflare Worker cron trigger once Sites supports it, or a manual/curl trigger).
- `Authorization: Bearer <CRON_SECRET>` - Vercel Cron's own convention: Vercel sends a project's `CRON_SECRET` as this header on requests to a `crons` entry in `vercel.json`, and its documentation shows handlers comparing exactly this (<https://vercel.com/docs/cron-jobs/manage-cron-jobs>). **A platform-triggered run has been observed**, both manually (`vercel crons run`) and, since 2026-09-27, from the platform's own schedule: the first natural execution fired at `2026-09-27 00:54:13 UTC`, returning `200` with zero runtime errors or warnings. Both conventions remain supported so that a misunderstanding of the request format degrades to "cron secret rejected", never to a silently unauthenticated endpoint.

Both env vars fail closed like every other secret check in this codebase: if unset, that path can never authorize a request, however it is called.

`vercel.json` schedules `GET /api/goldmine/scheduled` once a day (`0 0 * * *`), **not** the 5-minute cadence recommended above. That is not a pending decision: the Vercel team this deploys to (`vibe-code22`) is on the **Hobby** plan, which is limited to cron jobs that run once per day - a more frequent expression is rejected at deployment time, and even a daily job only fires to the nearest hour (somewhere in the 00:00-00:59 UTC window). See <https://vercel.com/docs/cron-jobs/usage-and-pricing>. A 5-minute cadence needs the Pro plan, which is a paid upgrade. This is the Vercel+Turso deployment's scheduler; it is independent of, and does not replace, a possible future Cloudflare Worker cron trigger for the Sites/D1 deployment (03C in the roadmap below).

**What daily scanning means for the numbers in this document.** Outcomes are only ever settled *when a scan runs* (section 4). Since Stage 06 the active horizons are sized for this cadence (section 4b), but the consequences of scanning once a day remain:

- **Every legacy intraday horizon is unobservable on this cadence, all four of them.** `15m`, `1h` and `6h` open and close between two scans and settle as `missed`. `24h` is the subtle case: its 3-hour window is narrower than the 24 h 59 min maximum gap between two daily runs, so whether it settled at all depended on cron drift - it was never reliable. Section 4b has the full table. The active `d1`/`d3`/`d7` horizons replace them for new signals; the legacy rows stay readable and visible, but they measure the schedule that recorded them, not the tokens.
- **An active horizon's observation is a daily snapshot, not an exact-time price.** It is the first daily scan at or after the target age, which can legitimately be the target age or roughly a day later. The actual elapsed time is always reported; read that, not the horizon name.
- Discovery sees one sample of "latest profiles and promoted tokens" per day, so a token that appears and fades inside a day is never scored at all. Coverage is a daily snapshot, not a continuous watch.
- Backtesting statistics computed over these signals therefore describe a once-daily sampling of the market. They are not a five-minute view and must not be presented as one, and per-horizon sample counts for the legacy intraday horizons will stay near zero permanently, because nothing writes them again.
- The freshness thresholds in section 3b (`CACHE_TTL_MS` 10 minutes, `MAX_FACT_AGE_MS` 15 minutes for contract-safety facts) are unaffected: they bound how stale a fact may be *within* a scan, and every scan re-fetches because the cache never survives a day.

## 5. Extension points

- **Contract safety dashboard:** built (section 6, 03B). `GET /api/goldmine`'s `signals[]` now includes each signal's `contractSafety`, reduced to the client-facing `ContractSafetySummary` shape (`{status}` for verified/unavailable, `{status, reason}` for unsafe) - never the stored `facts`, `failedChecks` wording beyond that reason, or RugCheck's own `providerRisks`/`providerScoreNormalized`, which stay server-side only. A deeper view would need a new, deliberately-scoped field, not widening this one.
- **Backtesting and calibration:** built (section 3c, 03D).
- **Paper trading:** a paper position can reference a signal ID and its detection price; no real funds.
- **Alerts:** new signals and state changes are rows with stable IDs, suitable for idempotent delivery.
- **Smart wallets:** a future snapshot field; the model version must change when it affects scoring.

## 6. Stage 03 roadmap

| Stage | Scope | Needs approval |
| --- | --- | --- |
| 03A (this) | Snapshot model, Momentum Score v2, hard gates, states, signal and outcome tracking, explanations. | No |
| 03B | Contract safety evidence (mint and freeze authority, top-holder concentration, LP status), so opportunities can exist (done, section 3b); Goldmine dashboard panel with explanations and outcome history (done, app/goldmine-panel.tsx). | Safety provider — approved and implemented: RugCheck's public API (section 3b) |
| 03C | Scheduled scans and outcome evaluation, and retention of old signals. | Confirm Sites supports Worker cron triggers. Done for the **Vercel+Turso** deployment (Stage 04, see docs/deployment-runbook.md) via Vercel Cron (section 4 above); the Sites/D1 deployment still has no scheduler until Sites supports Worker cron triggers. |
| 03D (this) | Backtesting and calibration: re-score stored snapshots, per-state and per-version outcome reports, threshold review (done, section 3c). | No |
| 06 (this) | Cadence-honest outcome evaluation: active daily-snapshot horizons with a proven observation window, legacy horizons kept readable, derived (never persisted) `expired_unswept`, actual elapsed observation times, all-history counts and separate control/strategy denominators (done, section 4b). Scoring, contract safety, `MODEL_VERSION`, the cron schedule and stored data are untouched. | No |
| 03E | Paper trading from signals, with simulated fees and slippage. No real funds. **Blocked on evidence, not on code**: section 4b explains why honest measurement is not a validated strategy, and nothing recorded so far is one. | No |
| 03F | Smart-wallet tracking. | Paid or keyed provider |
| 03G | Telegram alerts. | Bot token secret |

## 7. Known limitations

- DEX Screener provides no contract safety, unique-wallet counts or holder data; buyer growth uses swap counts. Contract safety instead comes from RugCheck (section 3b), and only for candidates that already cleared every hard gate — a `REJECTED` candidate's `contractSafety` stays `unavailable`.
- Discovery covers up to 30 recently profiled or promoted tokens, not the whole market. Promoted tokens are over-represented and receive no social points.
- Social momentum exists only where someone already ran an X search for the contract.
- The detection price is the discovery response, which the shared provider cache may have fetched up to 60 seconds before `detected_at`; outcome prices may be up to 10 seconds old.
- More than 150 due pools in one scan are deferred; if scans stop, deferred outcomes still become `missed` when their windows close.
- The scan lock expires after 300,000 ms (five minutes, `SCAN_LOCK_TTL_MS`); an overlapping scan cannot duplicate signals (IDs) or outcomes (primary key).
- Signals and outcomes currently have no retention or archival policy. Historical records are retained for backtesting and calibration; any future pruning design must preserve the aggregate evidence required by those features.
- An active horizon's observation is guaranteed to exist, not to be punctual. The proof in section 4b bounds the observation to `[target, target + 26h]`, and because every target is an exact multiple of the daily cadence, an observation legitimately lands near the target or roughly a day past it. Read `observedAfterHours`, never the horizon's name, as the holding period a return describes.
- The observability proof assumes the declared scheduler: consecutive scans no more than 24 h 59 min apart. A deployment outage, a failed function invocation or a scan blocked by a stale `goldmine:scan` lease can exceed that, and an active outcome whose window closes across such a gap becomes `missed` - correctly, and visibly, rather than being back-filled with a later price.
- The four legacy intraday horizons in stored history can never gain new observations. Their coverage is a fact about the schedule that recorded them, not about the tokens, and their rows are retained only so that history stays readable and the limitation stays visible.
