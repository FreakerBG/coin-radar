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

`POST /api/goldmine` (signed in, same origin, one shared lock `goldmine:scan`) first settles due outcomes, then discovers, scores, attaches contract safety (lib/goldmine/contract-safety.ts, Stage 03B) for actionable candidates, then re-scores and records. `GET /api/goldmine` reads recent signals and statistics. Without the D1 binding (the Vercel preview) both answer 503 before any provider call.

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

`lib/goldmine/contract-safety.ts` calls RugCheck's public, unauthenticated `GET /v1/tokens/{mint}/report` (no API key, no write endpoint, no wallet action; `/report/summary` was considered but omits mint/freeze authority, holders, creator and insider fields entirely). Only candidates that already cleared every hard gate are checked (`withContractSafety`) — a `REJECTED` candidate never depends on contract safety, so it never costs a request. Requests run one at a time, never in parallel, with an 8-second timeout and no retry; a fetched report is cached in memory for 10 minutes per mint, well inside RugCheck's observed unauthenticated rate limit (~15 requests per window), and the first `429` stops every further request for the rest of that scan. A single scan can surface up to 30 actionable candidates (lib/market.ts's discovery cap), so `attachContractSafety` also enforces its own ceiling regardless of 429s: at most `MAX_CHECKS_PER_SCAN` (12) requests, and no more once `SCAN_BUDGET_MS` (20s) of real wall-clock time has passed — both chosen to keep this stage from running past `goldmine:scan`'s own 60-second lock (lib/research-db.ts), which would let a second scan start concurrently. Candidates beyond either limit simply keep their existing (`unavailable`) contractSafety, the same predictable fail-closed outcome as a 429.

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

- **Reading, bounds and worst-case cost.** Signals are read in fixed, keyset-paginated pages (`SIGNAL_READ_BATCH_SIZE` = 200, ordered by `(detected_at, id)` **descending** so a page boundary is stable even between rows sharing a `detected_at` and, when the read is bounded, the *newest* signals are the ones kept), never as one unbounded query or a single `json_each(?)` bind of every id ever recorded; outcome lookups are likewise batched by id (`OUTCOME_ID_BATCH_SIZE` = 200). A hard cap on pages per request (`MAX_SIGNAL_READ_BATCHES` = 10, so `MAX_RETAINED_SIGNALS` = 2,000) makes the read bounded even against an unbounded table - if reached, the response's `truncated: true` says so honestly rather than silently reporting a partial history as complete, and the collected pages (newest-first) are reversed back to ascending order before any other module sees them, so replay/performance/calibration behave exactly as before. Each page is fetched with a one-row lookahead (`LIMIT signalBatchSize + 1`): if the extra row comes back, more history exists beyond this page (or this is the exact-cap case, which now correctly reports `truncated: false` when history ends exactly at the cap, and `true` only when at least one more row exists past it). **Worst-case D1 query count** for one request: `MAX_SIGNAL_READ_BATCHES` signal pages (10) + `ceil(MAX_RETAINED_SIGNALS / OUTCOME_ID_BATCH_SIZE)` outcome-id batches (10) = **20 queries**, independent of how much history is actually stored - chosen without assuming a paid Cloudflare plan, to leave wide margin below any conservative per-invocation query ceiling a Workers Free plan could impose. **Worst-case retained data**: at the cap, 2,000 signal rows (each a full snapshot + assessment, ~4 KB of JSON per row) plus up to 2,000 × 4 = 8,000 outcome rows; measured in the Node test harness (`tests/goldmine-backtest-limits.test.mjs`) at well under 20 MB of parsed JS objects for a maximal synthetic dataset, comfortably below a Workers isolate's 128 MB memory limit - Node's V8 and Workers' V8 isolate have different baseline/per-object overhead, so this is treated as a conservative approximation, not an exact Workers figure, but the margin (over 6x) is large enough to absorb that difference. No retention or deletion is implemented; stored history still grows without bound over time, and a deployment with more signals than this cap covers will see `truncated: true` until an archival policy exists (out of scope here).
- **Validation.** A row whose stored `snapshot`/`assessment` JSON is missing, corrupt, or structurally not a real `CandidateSnapshot`/`Assessment` is skipped and counted in `skippedMalformedRows`, never guessed at, never allowed to reach `scoreCandidate` with a shape it cannot safely process. `isValidStoredSnapshot` rejects `[]`, `{}`, `null`, wrong-typed fields, missing nested fields, any negative amount (liquidity, market cap, FDV, volume, transaction counts, age), and validates `contractSafety` as its real discriminated union - `unavailable`/`unsafe`/`verified` only, with `unsafe` requiring a non-empty string-array `failedChecks` and both `unsafe`/`verified` requiring a valid `source`/`checkedAt`/`facts`. `isValidStoredAssessment` rejects an unrecognized `state` (must be one of `STATES`) and a `score` outside `[0, 100]` (the real domain `scoreCandidate` can ever produce), alongside the previous shape checks. The row's own `model_version`/`state` columns are cross-checked against the parsed assessment's `modelVersion`/`state`; a mismatch is treated as malformed (replay/filtering read the column, calibration reads the assessment's content, so a disagreement between them must never enter either). `detected_price` must be a finite, positive number (every return computation divides by it). As defense-in-depth beyond structural validation, `replaySignal` also wraps its `scoreCandidate` call: an unanticipated bad row that still makes it throw is skipped and counted (`replay.invalidCount`) rather than turning the whole request into a 503 for every other signal. A genuine storage failure (a rejected D1 query) still fails the whole request rather than being counted as a malformed row.
- **Outcome validation.** A stored outcome row is validated against exactly the shape `evaluateOutcomes` ever writes: a known horizon, a known status (`pending`/`observed`/`unavailable`/`missed`), and status-appropriate nullability of `observed_at`/`price`/`liquidity` (e.g. `observed` requires a finite positive `price`). An unrecognized status string (a corrupt or hand-edited row, e.g. `'CORRUPT'` or `'Observed'`) is never reinterpreted as `pending` - that would silently inflate pending coverage and hide the corruption. It is excluded from coverage/returns and counted separately in `skippedMalformedOutcomes`.
- **Historical replay.** `scoreCandidate` is a pure function of the stored snapshot, so for a signal whose stored `model_version` equals the current `MODEL_VERSION`, recomputing it must reproduce the stored assessment exactly (`replaySignal`/`replayAll`); a mismatch would mean scoring drifted from what was recorded, or the stored row was tampered with. This is the only model version this codebase implements. A signal from any other stored `model_version` has no implementation to replay it with here: it is never run through the current `scoreCandidate` and relabeled as its historical result. It is reported as unsupported, with the original stored assessment as its only record - a mechanism that extends without rework once a v2.2.0+ exists. `replay.mismatchedSample` is a small, deterministic, bounded sample (`MISMATCHED_SAMPLE_LIMIT` = 20) of mismatched signal ids/addresses, never an unbounded list; `replay.mismatchedCount` is always the true total and `replay.mismatchedSampleTruncated` says whether the sample is a subset of it.
- **Performance analysis.** `performanceReport` groups every stored outcome by model version x signal state x horizon (15m/1h/6h/24h) and reports, per bucket: outcome coverage (`pending`/`observed`/`unavailable`/`missed` counts - every status counted, none dropped from the denominator or read as a zero return) and, over `observed` outcomes only, a return distribution (count, mean, median, sample standard deviation - `stdev` is `null`, not zero, below two observations, and a mean at `n=1` is a single data point, not a statistic; the dashboard marks it explicitly). A bucket with mostly `pending`/`unavailable`/`missed` coverage has little realized evidence regardless of what its handful of `observed` outcomes show; the coverage counts are reported specifically so that is visible, not hidden behind a mean. The dashboard table always shows a Model column alongside state and horizon, so rows from different model versions can never look identical.
- **Calibration and per-cell evidence.** `calibrationSweep` asks "what would the opportunity set and its outcomes have looked like at a different `OPPORTUNITY_MIN_SCORE`" without reading or changing the real threshold (60) in `lib/goldmine/score.ts`. It is restricted to the current `MODEL_VERSION` only (exposed as `calibration.modelVersion`): signals from any other stored `model_version` are excluded, never reinterpreted under these thresholds or blocker rules, and the exclusion is reported transparently as `calibration.excludedOtherVersionSignals` rather than silently. For each of a fixed set of candidate thresholds (40/50/60/70/80/90 - never chosen or searched for to fit the data), `wouldBeOpportunityAt` re-applies only the score gate to each stored assessment's already-decided state and other blockers. To avoid drawing a conclusion from the same data used to state it, stored signals are split chronologically at their median `detected_at`: the earlier ("reference") half is never scored or reported; only the later ("evaluation") half's outcomes are reported per threshold. **Every threshold/horizon cell carries its own `cellStatus`** (`'sufficient' | 'insufficient' | 'not_evaluable'`), computed only from that cell's own usable observed returns (`returnsPct.count` - the values `distribution()` actually computed over, not `coverage.observed`, which can exceed it when an `'observed'` outcome's price could not produce a finite return): `not_evaluable` when `eligible === 0`, `sufficient` once at least `MIN_OBSERVED_RETURN_SAMPLES` (20) usable returns exist, `insufficient` otherwise. A populated 15m cell never lends credibility to a weak or not-evaluable 1h/6h/24h cell, or to a different threshold row. `CalibrationResult` exposes exact reconciliation counts - `sufficientCellCount + insufficientCellCount + notEvaluableCellCount === totalCellCount` always. `descriptiveOnly` is `true` unless there is at least one evaluable cell, **every** evaluable cell is individually `sufficient` (`insufficientCellCount === 0`), and the evaluation half itself has reached `MIN_EVALUATION_SIGNALS` (20) - a single sufficient cell can never flip this to `false` while any other evaluable cell remains insufficient. Rows are still returned in full for visibility whenever `descriptiveOnly` is `true`, never withheld.
- **Dashboard.** `app/goldmine-panel.tsx`'s "Backtesting & calibration" section (view logic in `lib/goldmine/backtest-view.ts`) fetches this endpoint and shows the replay summary, the per-bucket performance table (with its Model column) and the threshold sweep (labeled with the single calibrated model version, any excluded other-version signal count, and the sufficient/insufficient/not-evaluable cell reconciliation) only once at least `MIN_SIGNALS_FOR_REPORT` (10) signals are recorded; below that it says so plainly instead of rendering a report built from a handful of rows. A data-quality banner (`hasDataQualityWarning`/`dataQualityWarning`) is shown whenever the read was truncated or any row/outcome was excluded for failing validation - it states explicitly that the analysis is partial, how many rows were analyzed, whether malformed data was excluded (and how much), and that a truncated read reflects only the most recently detected signals, never an unqualified "N signals recorded" that could be mistaken for the complete history. Each calibration cell that is not `sufficient` is labeled inline (`cellStatusLabel`) as "insufficient evidence" or "no eligible signals". It is read-only: it changes nothing and triggers no scan. Its tables scroll inside their own container rather than widening the page, checked down to a 320px viewport.
- **What this is not.** A research/diagnostic tool over historical detections, not a forecast: nothing here estimates or claims predictive accuracy or profitability, in the API, the dashboard or this document. Samples are not statistically independent - the same token can recur across scans, and one signal contributes to up to four overlapping horizon buckets at once - so every mean/median/stdev here describes this recorded history, not an estimate from independent trials. See section 7 for the same discovery-coverage and price-quote limitations that already apply to every signal this reads.

## 4. Signal tracking

- A signal is recorded for each priced candidate, including rejected ones (for gate evaluation later), at most once per model version, token, state and six-hour UTC bucket. It stores the detection price, the snapshot and the assessment. It holds no user data and every signed-in user reads the same signals.
- Each signal gets outcomes at 15m, 1h, 6h and 24h. An outcome is evaluated only inside its window (15m: 15-20 min, 1h: 60-75 min, 6h: 6-7 h, 24h: 24-27 h):
  - `observed`: the recorded pool returned a valid price (and liquidity when available);
  - `unavailable`: the provider answered without the pool or its price (possibly delisted);
  - `missed`: no scan ran inside the window. A later price is never recorded as the horizon's price;
  - a provider failure leaves the outcome pending for the next scan.
- Due outcomes are grouped by recorded pool and read in batches of at most 30 pools, earliest-closing window first (then pool and token), with at most 5 requests per scan, sent in parallel. A failed batch leaves only its own outcomes pending; pools beyond the cap are reported as `deferred` and read by the next scan while their windows are open.
- Evaluation runs only when someone scans, so without a scheduler many outcomes will be `missed`. Prices are provider quotes, not executable prices; returns ignore fees, slippage and liquidity.

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
| 03C | Scheduled scans and outcome evaluation, and retention of old signals. | Confirm Sites supports Worker cron triggers |
| 03D (this) | Backtesting and calibration: re-score stored snapshots, per-state and per-version outcome reports, threshold review (done, section 3c). | No |
| 03E | Paper trading from signals, with simulated fees and slippage. No real funds. | No |
| 03F | Smart-wallet tracking. | Paid or keyed provider |
| 03G | Telegram alerts. | Bot token secret |

## 7. Known limitations

- DEX Screener provides no contract safety, unique-wallet counts or holder data; buyer growth uses swap counts. Contract safety instead comes from RugCheck (section 3b), and only for candidates that already cleared every hard gate — a `REJECTED` candidate's `contractSafety` stays `unavailable`.
- Discovery covers up to 30 recently profiled or promoted tokens, not the whole market. Promoted tokens are over-represented and receive no social points.
- Social momentum exists only where someone already ran an X search for the contract.
- The detection price is the discovery response, which the shared provider cache may have fetched up to 60 seconds before `detected_at`; outcome prices may be up to 10 seconds old.
- More than 150 due pools in one scan are deferred; if scans stop, deferred outcomes still become `missed` when their windows close.
- The scan lock expires after 60 seconds; an overlapping scan cannot duplicate signals (IDs) or outcomes (primary key).
- Signals and outcomes grow without a retention policy until Stage 03C.
