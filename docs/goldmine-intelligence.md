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

### 6b.1a Scan interval: no fixed cadence guarantees observing the 15m window

An earlier draft of this section claimed a `*/15 * * * *` schedule "comfortably" covers the 15m outcome
window (15-20 minutes after detection, 5 minutes wide) "with slack." That claim was wrong and has been
replaced by the analysis below, encoded as regression tests in
`tests/goldmine-scheduled.test.mjs` (`describe('corrected scan-interval analysis...')`).

**Why a 15-minute interval has no real slack.** Detection happens at whatever instant a scan actually
runs, not at a fixed offset from a schedule - a signal's `detected_at` is that scan's own clock reading.
So if any one scan (the detecting scan, or the scan(s) after it) drifts off its nominal grid mark by even
a minute - ordinary scheduler dispatch jitter, a cold start, or the previous invocation overrunning its
slot - the window computed from the *actual* detection time no longer lines up with the *nominal* grid the
following scans still run on. Concretely: a cron fires at :00, :15, :30, but the :00 firing is dispatched a
minute late and actually runs at :01. The signal it detects has `due_at` = :16 and `deadline_at` = :21. The
next firing, exactly on time at :15, is one minute too early (`due_at` has not passed) and evaluates
nothing; the one after that, at :30, is nine minutes too late (past `deadline_at`) and the outcome is
marked `missed`. One minute of jitter was enough to turn a 15-minute interval - three times wider than the
window it needs to hit - into a total miss, because the interval itself, not just the jitter, exceeds the
window width. This is reproduced deterministically (fake clock, no real timers) in
`tests/goldmine-scheduled.test.mjs`.

**What actually reduces the miss risk.** A grid point lands inside a window of width `W` only if the
interval `T` and the accumulated jitter/drift between the detecting scan and the catching scan satisfy
`T + jitter ≲ W`. For the 15m horizon, `W` is 5 minutes, so `T` must be a fraction of that - not a fraction
of the horizon itself (15 minutes) - to leave any room for jitter, execution duration, provider retries or
a lock-busy skip (below) at all. A 5-minute interval (`*/5 * * * *`) is the smallest round-number cadence
that: (a) still lands a grid point inside a 5-minute window after the same one-minute jitter that breaks a
15-minute cadence (verified by the second test in the same describe block); (b) stays far enough below the
60-second scan lock (`lib/research-db.ts`) and this pipeline's typical run time (low single-digit seconds;
worst case bounded by `SCAN_BUDGET_MS` = 20s in `lib/goldmine/contract-safety.ts`) that back-to-back
overlap and lock-busy skips should be rare in normal operation; and (c) keeps per-scan RugCheck volume
unchanged (`MAX_CHECKS_PER_SCAN` = 12, already sized to this stage's ~15-request unauthenticated-window
observation regardless of call frequency) while relying on its 10-minute contract-safety cache
(`CACHE_TTL_MS`) to absorb most of the added call frequency for candidates that keep reappearing across
scans a few minutes apart - only genuinely new actionable candidates cost a fresh RugCheck request. At 12
scans/hour (288/day) this is a real, sustained increase in DEX Screener and (for new candidates) RugCheck
request volume over the current ad hoc manual cadence, and that cost has not been validated against either
provider's actual production rate limits from this repository - only estimated against the documented,
observed ones (section 3b).

**This is a reduction of risk, not a guarantee, and must not be described as one.** Even a 5-minute
cadence can still miss a 15m window if: the scheduler itself skips or delays several consecutive firings
(an outage on the caller's side, not this app's); a scan is skipped entirely because the `goldmine:scan`
lock is held by a concurrent manual or scheduled scan (the busy response is intentional and correct, but it
means that slot contributes nothing to coverage); or jitter on two consecutive firings compounds beyond the
margin above. The 1h (15-minute-wide), 6h (1-hour-wide) and 24h (3-hour-wide) windows are all wide enough
that either a 15-minute or a 5-minute cadence covers them with real margin; the fragility above is specific
to the 15m horizon's narrow, 5-minute window.

Cloudflare Cron Triggers support standard cron expressions down to one-minute resolution, so a 5-minute
interval (or, if a chosen platform can be shown to keep jitter and execution time small enough relative to
5 minutes, a finer one) is mechanically expressible once a trigger mechanism is confirmed (section 6b.1b).
**Do not claim reliable 15-minute (or any) automated tracking exists in production** until one of the
mechanisms below is confirmed and actually wired; until then, outcome evaluation runs only when someone
opens the dashboard and scans manually, exactly as in 03A/03B.

### 6b.1b Trigger mechanism

Two production targets exist and must not be confused (docs/deployment-runbook.md section 1):

- **The OpenAI Sites-hosted Worker** is the real production deployment: it owns the real D1 database and
  is the only place a scan can ever write a real signal. A native Cloudflare Cron Trigger, invoking the
  Worker's `scheduled(event, env, ctx)` export directly, is the correct primitive here — it bypasses HTTP
  and, with it, Sites' private-Site sign-in gate entirely, so it needs no secret and cannot be affected by
  whether that gate would otherwise block an automated caller.
- **The separate Vercel preview** (docs/deployment-runbook.md section 1) has no D1 binding by design and
  can never run a scan successfully. **Do not point any scheduler — Vercel Cron or otherwise — at the
  Vercel deployment's `/api/goldmine/scheduled`.** It would authenticate correctly (if `GOLDMINE_CRON_SECRET`
  were ever set there, which it should not be) and then fail every single time with a guaranteed 503,
  because `db()` throws before any provider call. No interval or retry policy fixes this; the blocker is
  the missing database, not the schedule.

**The exact question for the Site owner (or whoever administers the Sites publish):** *Does Sites' publish
tooling support Cloudflare Cron Triggers for this Worker, and if so, what is the exact way to declare one
for this project (a config field, a plugin setting, a separate provisioning step) so it is safe to add a
`triggers.crons` entry and a `scheduled()` export in this repository?* `.openai/hosting.json` has no field
for it today and this repository has no access to Sites' deploy-time configuration, so this cannot be
answered by more repository investigation - it is answerable only by the platform's own tooling or
documentation, which is unconfirmed from here.

**Minimum configuration to unblock, by answer:**

- **If yes (Cron Triggers are supported):** the platform owner supplies the exact declaration mechanism.
  This repository then needs: (1) a `scheduled()` export that calls `runGoldmineScan` under the same
  `goldmine:scan` lock as both HTTP routes; (2) the confirmed trigger declaration, at a 5-minute interval
  per section 6b.1a (not 15 minutes); (3) `POST /api/goldmine/scheduled` kept as a manual-override/backfill
  path, or retired once the native trigger is verified working in production. No `GOLDMINE_CRON_SECRET` is
  needed for this path — the trigger invokes the Worker directly, not through the private-Site HTTP gate.
- **If no (Cron Triggers are not supported, or cannot be confirmed):** the only remaining option is a
  separate, explicitly approved external caller (for example, another Cloudflare Worker with its own
  confirmed Cron Trigger) performing an HTTP `fetch` to this Site's production URL with the configured
  `GOLDMINE_CRON_SECRET`, at the same 5-minute interval. This is viable **only after** a second, separate
  confirmation: that Sites' private-Site sign-in gate lets an unauthenticated request carrying only the
  cron header through to `POST /api/goldmine/scheduled` at all, rather than intercepting and rejecting it
  before the Worker's own routing ever sees it (the gate's behavior for a request with no `oai-authenticated-user-*`
  headers and no interactive sign-in is not established anywhere in this repository). Do not configure or
  activate such a caller on the assumption that the gate passes it through — verify first, for example by
  making one manual, logged request with the header from outside a signed-in browser session and observing
  whether it reaches `POST /api/goldmine/scheduled` (and gets a real 401/200 from the route) or is stopped
  earlier by the gate (a different status or body, e.g. a sign-in redirect or the gate's own error page).

Until one of these two paths is confirmed and actually wired, no scheduler should be created or activated
for this project, on either target.

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
