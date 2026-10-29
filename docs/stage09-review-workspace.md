# Stage 09: evidence and manual review workspace

This branch is stacked on PR #39 (`release/manual-trading-ci`, `d74f1a8`). Two independent implementations of the Stage 09 plan existed: this PR's first commit (`a6b1083`) and the local-only `feat/stage09a-evidence` (`a8b9ecd`, built on the PR #39 tab fix `cad3a5b`). They are reconciled here by a merge that keeps both histories:

- **Stored evidence and near misses** come from Stage 09A (`lib/goldmine/review-evidence.ts`, `lib/goldmine/evidence-view.ts`, `app/candidate-evidence.tsx`). It replaced this PR's simpler drawer (`app/stored-evidence.tsx`, removed) because it keeps the scheduled scan response unchanged, never rescores a past fact, and classifies observation age.
- **Structured manual review** comes from this PR (`lib/manual-review.ts`, `app/live-trade-review.tsx`). Stage 09A had no equivalent.
- **Tab overflow** comes from `cad3a5b`. This PR's duplicate rule was dropped.

## Behavior

- `reviewEvidence` is a separate allow-listed field. The badge's `contractSafety` stays the minimal status/reason shape. GET `/api/goldmine` includes it for every non-REJECTED row of the existing 50-row read, and the signed-in POST includes it per candidate. The scheduled routes never request it, so the response the scheduler Worker reads is unchanged.
- The allow-list contains our own derived RugCheck numbers and booleans, DEX Screener snapshot values, and their separate observation times, plus the stored assessment's own gate messages. RugCheck's score, its risk list, risk descriptions, raw reports and the stored `facts` object never reach the client. Stored check messages that embed a provider risk name are reduced to `RugCheck reports a danger-level risk.` in both the badge `reason` and `reviewEvidence`. Storage keeps the full message, and scoring is unchanged.
- Evidence is identity-bound. A stored snapshot whose mint or pool differs from its signal row is reported as unreadable, so it can never be shown under another token or pool.
- Missing, malformed and out-of-range values are **Not measured**, distinct from zero and false. A fact reads "within check" only when the stored result proves its check passed at detection.
- Each time reads as recent (15 minutes or less, the same limit a safety decision uses), past, uncertain (up to 5 minutes in the future), invalid (further in the future) or unknown. A recent snapshot is still described as not a live quote. Loading a stored signal never renews its observation time.
- Sources are labelled: the detected-pool DEX Screener snapshot is distinguished from RugCheck's LP aggregate across reported markets. Transaction counts are swaps, not wallets, and sellability for an order is unverified. Snipers, bundles, dev-linked wallets and follower authenticity are listed as not measured by Coin Radar.
- **Not trade-ready** is a collapsed list of current-model, non-REJECTED, non-opportunity signals from the existing 50-row read: one per mint and pool, newest first, showing at most ten. It offers only Copy mint and a DEX Screener pool link. It has no trading-app or Advisor action and changes no gate.
- The Advisor shows five session-local review groups: identity, contract/distribution, wallets/audience, execution, and costs/full-loss budget. Each starts Unknown, a blocker dominates the status, and completion is described as not automated verification. The component is keyed by `mint:pool`, so changing either discards every note. Exact-pool DEX Screener data is shown only while under 90 seconds old and is labelled as possibly cached, not an executable quote or a live contract check.
- Notes are never persisted, sent to a trading app, or included in portfolio writes. An already completed fill can still be recorded manually, with its actual price and amount, so existing exposure is tracked and monitored. Nothing here places an order.
- The six-tab bar scrolls at every width instead of widening the page.

## Release gates

On 2026-10-03, `main` was at `3dbd65d` (PR #33, never deployed), and production was READY deployment `dpl_3rwfJozu3E6xk5TvhvSyiP1DNENa` at `c435d30`. Branch protection on `main` requires the GitHub Actions checks `Verify` and `Browser smoke`. The FreakerBG account, the repository and its API endpoints all return 404 to unauthenticated requests. The Actions API reports zero runs, including runs that previously existed, and no Vercel git deployment has been created since 2026-09-30 07:25 UTC, although the project's GitHub link is intact. Both match a hidden/flagged GitHub account, which stops workflow and app webhook delivery. Only GitHub Support can clear that; it is not a workflow or Vercel configuration fault.

Do not merge or publish until the required checks run on the exact head. Merge PR #39 first, then this branch against the resulting `main`.

This stage makes no schema, migration, scoring threshold, scheduler, cron, secret, alert-sender, production-data or trading-account changes. The daily cron (`0 0 * * *`, `/api/goldmine/scheduled`) is unchanged.

## Validation

Run `npm run verify`, `npm run test:worker` and `npm run test:browser` on the final combined tree. Tests cover the minimized badge, allow-listed GET/POST evidence, the unchanged scheduled response, malformed and missing data, forbidden provider payloads including risk names, mint/pool identity, freshness tiers, near-miss boundaries, manual review transitions and reset, no automatic portfolio writes, and tab overflow at 390 to 900 px. Browser fixtures block non-local requests.
