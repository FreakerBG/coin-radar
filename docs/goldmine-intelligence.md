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

## 4. Signal tracking

- A signal is recorded for each priced candidate, including rejected ones (for gate evaluation later), at most once per model version, token, state and six-hour UTC bucket. It stores the detection price, the snapshot and the assessment. It holds no user data and every signed-in user reads the same signals.
- Each signal gets outcomes at 15m, 1h, 6h and 24h. An outcome is evaluated only inside its window (15m: 15-20 min, 1h: 60-75 min, 6h: 6-7 h, 24h: 24-27 h):
  - `observed`: the recorded pool returned a valid price (and liquidity when available);
  - `unavailable`: the provider answered without the pool or its price (possibly delisted);
  - `missed`: no scan ran inside the window. A later price is never recorded as the horizon's price;
  - a provider failure leaves the outcome pending for the next scan.
- Due outcomes are grouped by recorded pool and read in batches of at most 30 pools, earliest-closing window first (then pool and token), with at most 5 requests per scan, sent in parallel. A failed batch leaves only its own outcomes pending; pools beyond the cap are reported as `deferred` and read by the next scan while their windows are open.
- Evaluation runs only when someone scans, so without a scheduler many outcomes will be `missed`. Prices are provider quotes, not executable prices; returns ignore fees, slippage and liquidity.

## 4b. Dashboard review (Stage 03C audit of app/goldmine-panel.tsx)

No dashboard code changed in Stage 03C; this is an audit against Stage 03B's requirements, for a future,
separately-scoped dashboard change:

- **No auto-refresh.** `GET /api/goldmine` (recent signals) is fetched once on mount and again after a
  manual "Scan now" click; nothing polls it. Once an automated scan exists (section 6b.1), signals it
  records will not appear until the user reloads or scans manually themselves — the dashboard has no way
  to reflect background activity.
- **`stats` is computed but never rendered.** `readTracking` (lib/goldmine/signals.ts) returns per-state,
  per-horizon outcome statistics (pending/observed/unavailable/missed counts, mean return, positive
  share); `GET /api/goldmine` serves them, but `app/goldmine-panel.tsx` never reads `tracking.stats` at
  all. This is the most direct outcome-visibility gap for evaluating whether the model is any good.
- **No manual/automated distinction.** The "Last scan" line only reflects the current browser session's
  own POST response; there is no way to tell from the dashboard whether the most recent recorded signal
  came from a person or an automated caller.
- **Missing/rejected candidates are invisible in history.** "Recent opportunities" filters to
  `signal.opportunity`; a REJECTED or non-actionable candidate is recorded (for future gate evaluation)
  but never shown anywhere in the UI, so a user cannot see why a token they noticed never appeared.
- **Mobile usability:** verified fine at the layout level — `npm run test:browser` includes Goldmine at
  320/360/390/768/1440px with no horizontal overflow — but this is a base viewport check, not a review of
  information density or touch target size specific to the Goldmine cards.

## 5. Extension points

- **Contract safety dashboard:** built (section 6, 03B). `GET /api/goldmine`'s `signals[]` now includes each signal's `contractSafety`, reduced to the client-facing `ContractSafetySummary` shape (`{status}` for verified/unavailable, `{status, reason}` for unsafe) - never the stored `facts`, `failedChecks` wording beyond that reason, or RugCheck's own `providerRisks`/`providerScoreNormalized`, which stay server-side only. A deeper view would need a new, deliberately-scoped field, not widening this one.
- **Backtesting:** stored snapshots re-score under any model version with `scoreCandidate`; outcomes give the realized quotes.
- **Paper trading:** a paper position can reference a signal ID and its detection price; no real funds.
- **Alerts:** new signals and state changes are rows with stable IDs, suitable for idempotent delivery.
- **Smart wallets:** a future snapshot field; the model version must change when it affects scoring.

## 6. Stage 03 roadmap

| Stage | Scope | Needs approval |
| --- | --- | --- |
| 03A | Snapshot model, Momentum Score v2, hard gates, states, signal and outcome tracking, explanations. | No |
| 03B | Contract safety evidence (mint and freeze authority, top-holder concentration, LP status), so opportunities can exist (done, section 3b); Goldmine dashboard panel with explanations and outcome history (done, app/goldmine-panel.tsx). | Safety provider — approved and implemented: RugCheck's public API (section 3b) |
| 03C (this) | Scan pipeline extracted for reuse; a fail-closed, secret-protected automated entry point (`POST /api/goldmine/scheduled`) built and tested. **Actually triggering it on a schedule remains blocked** (section 6b.1). | Platform confirmation of a working scheduler |
| 03D | Backtesting and calibration: re-score stored snapshots, per-state and per-version outcome reports, threshold review. | No |
| 03E | Paper trading from signals, with simulated fees and slippage. No real funds. | No |
| 03F | Smart-wallet tracking. | Paid or keyed provider |
| 03G | Telegram alerts. | Bot token secret |

## 6b. Automated scans (Stage 03C)

`lib/goldmine/scan.ts` extracts the scan pipeline (settle due outcomes, discover, score, verify contract
safety, record) out of the POST route, so any authorized caller can run it under the same
`goldmine:scan` lock. Two callers exist:

- `POST /api/goldmine` (unchanged): signed-in ChatGPT session, same-origin, exactly as before.
- `POST /api/goldmine/scheduled`: a dedicated, fail-closed secret (`GOLDMINE_CRON_SECRET`, header
  `x-goldmine-cron-secret`) instead of a session or Origin check, since an automated caller has neither.
  An unset, empty or wrong secret is always rejected before any storage or provider call — never a
  configuration that accidentally authorizes everyone. It reuses the same lock, so a manual and an
  automated scan can never run concurrently, and the same idempotent signal/outcome handling, so neither
  can duplicate a record the other already wrote. It never requests X, respects the same RugCheck and
  DEX Screener budgets as the manual route, and completes on the same order of magnitude (well inside
  the 60-second scan lock).

### 6b.1 What is not done, and why

Nothing in this repository or its build wires an actual periodic trigger to either route, and this is a
deliberate stop, not an oversight. Two possible mechanisms were assessed against the real hosting
(docs/deployment-runbook.md section 1) and neither could be verified safe:

1. **Vercel Cron**, calling an HTTP endpoint on a schedule, is the natural fit for `vercel.json` and is
   what `GOLDMINE_CRON_SECRET`/`POST /api/goldmine/scheduled` was shaped after. It cannot work at all on
   this project's Vercel deployment: that build has no D1 binding by design
   (`lib/vercel-cloudflare-workers.ts` freezes `env` empty), so `db()` throws immediately and every scan
   would be a guaranteed, permanent `503`. No cron frequency fixes this; the blocker is the missing
   database, not the schedule.
2. **A Cloudflare Cron Trigger**, invoking the Worker's native `scheduled(event, env, ctx)` export
   directly (bypassing HTTP and, with it, Sites' private-Site sign-in gate), is the correct primitive for
   the actual production target — the OpenAI Sites-hosted Cloudflare Worker that owns the real D1
   database. Whether Sites' proprietary publish tooling reads or honors a `triggers.crons` declaration is
   **unconfirmed**: `.openai/hosting.json` has no field for it, `vite.config.ts`'s binding config is for
   local Miniflare only and is not what Sites deploys, and this repository has no access to Sites'
   deploy-time configuration to add or test one. Adding an unwired `scheduled()` export on the strength
   of a guess would be exactly the "fake scheduler" this stage must not ship.

Cron frequency itself was still worth assessing in case support is confirmed later: Cloudflare Cron
Triggers support standard cron expressions down to one-minute resolution, so a `*/15 * * * *` schedule
would comfortably keep the 15m window's 5-minute slack (and every wider window) covered. **Do not claim
reliable 15-minute (or any) automated tracking exists in production** until one of these mechanisms is
confirmed and actually wired; until then, outcome evaluation runs only when someone opens the dashboard
and scans manually, exactly as in 03A/03B.

**Next step to unblock:** get the Site owner (or whoever administers the Sites publish) to confirm
whether Cron Triggers are supported and how to declare one for this Worker. If yes, add a `scheduled()`
export that calls `runGoldmineScan` under the same lock and wire the trigger; `POST
/api/goldmine/scheduled` can then be retired or kept as a manual-override/backfill path. If Sites cannot
support this, the alternative is a separate, approved external caller (for example, another Cloudflare
Worker with its own confirmed Cron Trigger performing a fetch to this Site's production URL with the
configured secret) — but only after confirming Sites' private-Site gate does not itself block that
request before it reaches the Worker.

### 6b.2 Signal retention (proposed, not implemented)

Signals and outcomes still grow without a retention policy. No deletion code ships in this stage: Stage
03D (backtesting) re-scores stored snapshots under later model versions, so removing rows now would
remove data a still-planned stage needs, and there is no scan volume data yet (scans are still manually
triggered) to size a policy against. Proposed policy for a later stage, once 03D's needs and real volume
are known: delete only signals whose every outcome has reached a terminal status (`observed`,
`unavailable` or `missed` — never one still `pending`) and whose latest (24h) outcome resolved more than
a fixed number of days ago, in small bounded batches (matching the existing chunked-write pattern in
`lib/goldmine/signals.ts`), with `goldmine_outcomes` rows removed by the same `signal_id` set in the same
operation. This is additive-safe (no schema change, no migration) but still deletes data, so it needs its
own review and explicit approval before it ships, not a default assumed here.

## 7. Known limitations

- DEX Screener provides no contract safety, unique-wallet counts or holder data; buyer growth uses swap counts. Contract safety instead comes from RugCheck (section 3b), and only for candidates that already cleared every hard gate — a `REJECTED` candidate's `contractSafety` stays `unavailable`.
- Discovery covers up to 30 recently profiled or promoted tokens, not the whole market. Promoted tokens are over-represented and receive no social points.
- Social momentum exists only where someone already ran an X search for the contract.
- The detection price is the discovery response, which the shared provider cache may have fetched up to 60 seconds before `detected_at`; outcome prices may be up to 10 seconds old.
- More than 150 due pools in one scan are deferred; if scans stop, deferred outcomes still become `missed` when their windows close.
- The scan lock expires after 60 seconds; an overlapping scan cannot duplicate signals (IDs) or outcomes (primary key).
- Signals and outcomes still grow without a retention policy; a policy is proposed, not implemented (section 6b.2).
- No automated scan actually runs yet: `POST /api/goldmine/scheduled` (section 6b) exists and is tested, but nothing triggers it periodically in production (section 6b.1). Evaluation still runs only when someone scans manually.
