# 15-minute Goldmine detection: safety-first implementation plan

Status: design only. No scheduler, secret, production environment variable, database migration, or scan cadence is changed by this document.

## Owner decisions

- Target a 15-minute **detection** cadence, free tier first. Present any paid requirement before adopting it.
- Keep verified safety and market gates for trade-oriented alerts; retain rejected and uncertain signals for research/calibration.
- Detect first. Keep the existing daily outcome reports until reliable intraday observations exist; do not relabel them as 15-minute outcomes.
- Investigate a separate Cloudflare scheduled Worker under the owner's Cloudflare account. Production remains on Vercel + Turso.
- Axiom and Phantom remain manual destinations. This stage does not place orders or connect a wallet.

## Current facts and blockers

1. `vercel.json` schedules `GET /api/goldmine/scheduled` at `0 0 * * *`. Vercel Hobby rejects a more frequent Cron expression and may invoke a daily job anywhere within its scheduled hour. Do not change this to `*/15` on Hobby. [Vercel Cron usage](https://vercel.com/docs/cron-jobs/usage-and-pricing)
2. Cloudflare Workers supports a `scheduled()` handler and cron triggers. A separate Worker could send an authenticated request to the existing Vercel endpoint; it must be deployed and operated in an account the owner controls. Confirm the account's free-plan limits before activation. [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) · [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
3. The endpoint already accepts `POST` with `x-goldmine-cron-secret` when `GOLDMINE_CRON_SECRET` is set. It uses the same `goldmine:scan` lock as interactive scans. It returns `busy` when another scan holds the lock. A `200` response alone is therefore not proof that a scan ran.
4. `runGoldmineScan()` is **not detection-only**: it first calls `evaluateOutcomes()`, then discovers, scores, makes bounded RugCheck calls, and records every priced candidate. Calling it every 15 minutes would change outcome observation semantics without changing the declared `daily-snapshot-v1` schedule in `lib/goldmine/cadence.ts`.
5. A 15-minute scheduler means 96 scheduled invocations/day. At the current discovery cap of 30 tokens this is up to 2,880 candidate signal rows/day, before interactive scans. `readAllSignalsWithOutcomes()` reads at most the newest 2,000 rows and reports truncation; it does not delete old rows. At the worst-case cap, a day of scans could exceed the backtest read window. This is a capacity scenario, **not** an observed production rate.
6. `withContractSafety()` allows at most 12 RugCheck reports and 20 seconds per scan. At 96 scans, the theoretical ceiling is 1,152 report calls/day; the current 10-minute cache is in-process and cannot be assumed to persist across Vercel invocations. Its previously observed unauthenticated rate limit and fresh-report requirements require a measured budget before ramp-up. A 429 leaves safety unavailable and therefore no opportunity.

## Delivery sequence

### A. Scheduler proof of concept, no production scan

- Add a standalone Worker with a secret-protected scheduled handler and a narrowly fixed production origin/path. Do not expose the secret in a URL, response, log, repository, or browser bundle.
- Start with scheduling disabled or a non-scanning test target. Verify Cloudflare account permissions, cron propagation, execution logs, failure reporting, and timeout behavior without calling the production scan.
- Keep the existing Vercel daily Cron unchanged. No second live scan source is enabled in this phase.

### B. Detection/outcome separation and bounded writes

- Split detection from outcome settlement (or add explicit, tested mode boundaries). Intraday calls must not silently settle daily outcomes or claim a new evaluation schedule. The existing daily job must retain its truthful d1/d3/d7 behavior.
- Decide how to represent repeated snapshots of the same mint: deduplicate notifications, preserve enough research/control observations, and bound storage/backtest reads without hiding truncation. Do not simply drop rejected controls or rewrite old outcomes.
- Model signal volume under realistic discovery overlap, Turso reads/writes, and retention. Add tests for 96 daily runs, duplicate mints, empty scans, restarts, and mixed manual/scheduled calls.
- Measure DEX Screener and RugCheck responses at a limited cadence. Define a provider-specific cooldown/circuit breaker and fail-closed safety behavior; do not assume in-memory cache survives a serverless invocation.

### C. Cautious production ramp

- Configure the Worker secret in Cloudflare and a matching dedicated `GOLDMINE_CRON_SECRET` in Vercel via approved secret management. Verify unauthorized requests fail and that logs redact the value.
- First run authenticated manual canary calls with recorded response status, `checked`/`busy`/`provider_unavailable`, signal count, duration, provider warnings, and resulting latest batch. A `busy` or provider failure is not a success.
- Ramp in steps rather than enabling 96 daily scans immediately; monitor rate limits, safety-check coverage, storage growth, and backtest truncation. Document a pause/rollback switch and retain the daily Vercel Cron until the replacement is proven.
- Only then enable `*/15 * * * *` for detection. Never leave two independent full-scan schedules running at once merely because their locks prevent simultaneous execution.

## Go/no-go gates

Go only when the owner-controlled Worker account and secrets are ready; the detection/outcome split is tested; signal storage and report windows remain honest under projected volume; provider budgets have been measured; canary scans are observable; and a rollback to the known-good daily schedule has been rehearsed. Otherwise keep the current daily production schedule.

This plan does **not** promise that an opportunity is found every 15 minutes, that every market token is covered, or that a trading alert is a price guarantee or an executable order.
