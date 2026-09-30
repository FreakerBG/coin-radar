# Filter and outcome audit (2026-09-30)

The objective is a manual Axiom research shortlist, not automatic execution. This audit does not change scoring, safety gates, detection cadence, alerts, or production data.

## What current code can establish

- An opportunity requires an EARLY/BUILDING/BREAKOUT state, score at least 60, all market risk inputs assessed, and verified contract safety. Rejected candidates cannot be opportunities. RugCheck prioritizes candidates whose only remaining blocker is contract safety; a provider check alone cannot rescue other failures.
- `GET /api/goldmine/backtest` is signed-in and read-only. Its new `filterFunnel` counts current-model signals by rejected/actionable/opportunity status, safety status, rejection IDs, blocker IDs, and candidates whose only blocker was contract safety. A signal can have several reasons, so reason counts overlap.
- The response's existing `coverage` and `truncated` fields apply to the funnel. The detailed read is capped at the newest 2,000 signals across model versions, while `totals` counts all stored signals independently. At 349 *distinct pairs* per rolling day, one cannot derive an exact number of stored signals per day; the 2,000-row cap could still cover substantially less than the 30-day research target. Check `coverage`, never describe the funnel as all history when truncated.
- Outcome analysis uses observed daily snapshots at 1-, 3-, and 7-day targets. Recent signals have pending outcomes; observed price ratios are not executable net returns. Control (REJECTED) and strategy rows have separate denominators, and repeated pairs are not independent observations.

## Production evidence needed before tuning the filter

1. Once the hourly ramp is confirmed dormant, read `GET /api/goldmine/backtest` while signed in. Record `generatedAt`, `totals`, `coverage`, `truncated`, `filterFunnel`, `denominators`, active-horizon `performance` and `calibration`. A zero opportunity count is a valid result, not permission to remove a safety gate.
2. Determine the most frequent **non-safety** blockers and hard rejections, the size of the safety-only near-miss group, and how many opportunity outcomes are observed versus pending/unavailable/missed. Review a small sample of exact stored snapshots for anomalous input and stale provider evidence without exporting secrets or customer data.
3. Evaluate any proposed rule using later, untouched observations and the actual opportunity denominator. Report fees, slippage, liquidity and sampling bias as limits. Do not optimize a score threshold on the same observations used to claim performance.
4. Only then propose a versioned filter change or a different discovery source. Keep contract-safety failure closed. PR #33's Axiom/Phantom handoff may ship separately after ramp review; opening a link remains a manual decision, not evidence of a trade.

The hourly ramp reached `pairs24h=349` at 07:00 UTC on September 30, above the agreed 300-pair gate for 15-minute detection. This audit makes no inference that hourly scans are profitable or that any scanned coin is safe to trade.
