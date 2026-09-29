# 15-minute detection: activation status and handoff (2026-09-29)

For the owner and for whoever continues this work. It records what is live, what is merged but dormant,
what is blocked and on whom, and the evidence behind the current decision. **Decision: 15-minute
detection is NO-GO.** No Cloudflare Worker is deployed, no trigger exists, and the only unattended scan is
the daily Vercel Cron.

## What is live in production (Vercel `vibe-code22/coin-radar`, Turso `coin-radar-prod`)

| PR | Merge | Production deployment | What it does |
| --- | --- | --- | --- |
| #25 | `edcbec9` | `dpl_H3FXbsnMxu1hgnJ4ZwnShx47ip7U` | Persisted RugCheck cooldown in `research_locks`, and `coin_radar.scan_outcome` log lines with duration, counts and contract-safety coverage |
| #26 | `6758426` | `dpl_3g13n78w9pfDVWBuh1x4BuKW79DP` | The backtest discloses the exact window it covers and whether it reaches the 30-day target |
| #27 | `b6b6651` | `dpl_5Vq3GA2oNdZt4F4jGEn4LscEvuKS` | Daily settlement sized to 1,200 pools/run; 96/day capacity model; query-plan guard |
| #23 | `ede1ea6` | `dpl_BPAsaFMcVopkukjKum69dyu4kamK` (nothing deployed to Cloudflare) | Scheduler Worker code, dormant: bypass-capable, `noRetry`, no HTTP handler |

None of these changed the schema, and no production data was deleted, pruned or rewritten. Each release
was verified: exact commit, READY, all three aliases on it, the cron still `0 0 * * *`, unauthorized scheduled
GET/POST answered by the app's own 401 (not the SSO page), and 0 error-level runtime logs afterwards.
The rollback target at each step was the previous production deployment. None was needed.

**Observed unattended daily run on the new code:** `2026-09-29T00:54:13Z` on `dpl_5Vq3…`:
`GET /api/goldmine/scheduled` 200 with `status: checked`, `durationMs: 1553`, 28 candidates, 2 opportunities,
28 new signals and `outcomesSettled: true`. Safety coverage: 6 eligible, 4 verified, 2 unsafe, 0 unavailable,
6 RugCheck requests, no 429, cooldown `none`.

## Open, not merged

- **#28 durable alert eligibility and outbox (draft).** Adds additive migration `0002_goldmine_alert_outbox`.
  It must not merge before the production Turso migration, because `/api/health` would report
  `schema: incompatible` until then. No sender is wired, so unattended notifications are **not live**.
- **#22 plan (draft).** Design history. Superseded in its specifics by `docs/capacity-96-per-day.md`,
  `scheduler/README.md` and this file.

## Activation gates

| Gate | Status | Evidence / what is missing |
| --- | --- | --- |
| PR #25 and the storage/report/alert safeguards merged and READY | **Not met** | #25, #26 and #27 are live. The alert safeguard (#28) needs the Turso migration first (owner) |
| Worker authenticated, owner-controlled, observable, with a tested off switch | **Not met** | Code is ready and tested under the real workerd runtime. Deployment needs `wrangler login`: this machine has no Cloudflare credentials, and two OAuth attempts timed out unattended |
| Canary scans returned `checked` with acceptable duration, coverage, provider behavior and Turso use, and settled no outcomes | **Not run** | Requires the gates above. `GOLDMINE_CRON_SECRET` is not set in production, so no external caller can reach the POST |
| 96/day projection fits free-tier and provider limits with margin | **Unresolved** | Per-invocation cost fits easily (`docs/capacity-96-per-day.md`). The binding constraint is distinct pairs/day against daily settlement (sustainable ~400; the gate is ≤300), which only a canary can measure. RugCheck's limit is unpublished, handled by the 12-check cap and 30-minute cooldown. This account's Turso usage has not been read |
| Research controls and backtest coverage honest; 30-day policy answered | **Met** | Controls are recorded and reported separately. The backtest states its covered window. Storing 30 days fits; analyzing 30 days at 15 minutes does not fit the 2,000-row read, and the report says so. Nothing is pruned |
| Alert idempotency durable; any claimed delivery genuinely works | **Not met** | Implemented and tested in #28 (not deployed). No delivery is claimed anywhere |
| Daily d1/d3/d7 outcome schedule and manual Axiom/Phantom flow still work | **Met** | Unattended daily run above. Axiom/Phantom links are untouched |
| Stop/rollback rehearsed | **Not met** | The kill switch is documented (`scheduler/README.md`) and the dormant config is tested, but it cannot be rehearsed without a deployed Worker |

## Next steps, in order (owner actions marked)

1. **Owner:** in the Turso dashboard, confirm a point-in-time restore point for `coin-radar-prod`; then
   `npm run db:migrate:turso` with the production URL/token. Expect `0002_goldmine_alert_outbox` applied; a
   second run must be a no-op.
2. Mark #28 ready, then CI and merge. Verify the deployment, `/api/health` `schema: compatible` (signed in), and
   `alertsQueued` in the next `scan_outcome` line.
3. **Owner:** `npx wrangler login`. Then `npx wrangler deploy --config scheduler/wrangler.jsonc` (dormant),
   `node scheduler/provision-secrets.mjs`, and one production redeploy so Vercel picks up `GOLDMINE_CRON_SECRET`.
4. Verify unauthorized calls still get 401, and a non-scanning trigger logs `"status":"disabled"`.
5. Canary: at most 3 authenticated detection-only POSTs, at least 20 minutes apart. Record for each: time,
   `durationMs`, HTTP code, `status`, `newSignals`, `safety.*`, 429s, `outcomesSettled: false`, and the Turso
   dashboard before and after.
6. Rehearse OFF: deploy the committed `wrangler.jsonc` and confirm the next event logs `disabled`.
7. Ramp only if 5 and 6 pass: hourly (`0 * * * *`, `SCAN_ENABLED=true`) for at least 24 h. Check the Trigger
   Events cadence, statuses and projected distinct pairs/day (≤300). Only then `*/15 * * * *`, watching the first
   runs, and fall back to hourly or OFF on any failed gate.
