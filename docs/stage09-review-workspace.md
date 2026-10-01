# Stage 09: evidence and manual review workspace

This stage is stacked on PR #39 (`release/manual-trading-ci`, `d74f1a8`). It adds the previously planned stored evidence view and a structured live manual review before the existing completed-fill form. The earlier local-only tab fix and Stage 09A commits are not present on GitHub; this branch implements the remote-reviewable version from that pinned release base. Do not cherry-pick both implementations without reconciling them.

## Behavior

- Scan results and recorded signals expose the same `reviewEvidence` allow-list. The badge's `contractSafety` remains the existing reduced status/reason shape.
- The allow-list contains our stored normalized numbers/booleans and separate DEX Screener/RugCheck observation timestamps. Provider scores, provider risk text, raw reports and arbitrary source text stay server-side.
- Missing, malformed and out-of-range fields are null and render as **Unknown**. False and zero remain distinct from missing data. Future timestamps have unknown age. Downloading a stored signal does not renew its observation time.
- The evidence drawer distinguishes detected-pool DEX data from RugCheck's aggregate LP observations across reported markets. Transaction counts are not distinct wallets; zero detected insider networks is not evidence of independent holders. Snipers, bundles, verified follower counts and executable sellability remain unverified.
- The collapsed **Not trade-ready** list contains at most ten high-scoring actionable-state records whose stored opportunity flag is false, drawn from the existing latest-50 read. It does not display trading or Advisor actions, change a gate, or claim whole-history coverage.
- Advisor has five session-local manual observation groups: identity, contract/distribution, wallets/audience, execution, and costs/full-loss budget. Each starts Unknown; a blocker dominates the displayed status. Completion is explicitly not automated verification.
- Changing mint or pool resets all notes. The current exact-pool provider response is distinguished from a live quote and expires from this display after 90 seconds. Notes are not persisted, sent to a trading app, or included in portfolio writes.
- An actual completed fill can still be recorded with unresolved review notes so existing exposure is trackable. The fill price and amount must still be supplied manually. Neither inspection nor acknowledgement records a position or places an order.
- The six-tab bar scrolls at intermediate widths, not only below 600px.

## Release gates

The audit on 2026-10-01 found `main` at `3dbd65d`, PR #39 open at `d74f1a8`, and the production alias on READY deployment `dpl_3rwfJozu3E6xk5TvhvSyiP1DNENa` at `c435d30`. GitHub's Actions runs endpoint returned zero runs and the release head had zero check runs. Vercel showed previews for earlier branches, but no release/manual-trading-ci preview. This establishes missing release evidence; it does not establish why the integrations stopped triggering.

Before publishing, restore or otherwise obtain the exact-head CI and Vercel preview gates for the combined release. Merge PR #39 first, then reconcile this stacked branch against the resulting main. Do not interpret this draft PR as a production release.

The unauthenticated production health request returned the expected 401 with `Cache-Control: no-store`. This verifies the sign-in boundary, not database health. The production runtime-log count query returned no rows, so no conclusions about scanner operation or errors can be drawn from it. Project-settings inspection was blocked by a connector argument mismatch.

This stage makes no schema, migration, scoring threshold, scheduler, cron, secret, alert-sender, production-data or trading-account changes. The existing daily cron remains unchanged. Live Worker configuration is outside this stage and was not independently inspected with the selected connectors.

## Validation

Run `npm run verify`, `npm run test:worker`, and `npm run test:browser` on the final combined tree. Tests cover minimized badge compatibility, allow-listed GET/POST evidence parity, malformed/missing data, forbidden provider payloads, near-miss boundaries, manual review transitions, no automatic portfolio writes, target reset and intermediate-width tab overflow. Browser fixtures block non-local requests.
