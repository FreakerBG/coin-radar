# Coin Radar

Private Solana research dashboard with market discovery, X evidence, budget-based conditional allocation, recorded manual positions and entry/exit review alerts. No wallet connection, signing, swaps or custody.

## Runtime and setup

Vinext/React on Cloudflare Workers. Cloudflare D1 is declared as DB in `.openai/hosting.json`. Production migrations must be applied before using the research routes. The Site remains private.

X requires an `X_BEARER_TOKEN` server-side secret set in Sites environment settings and a publication applying that environment revision. Never put credentials in browser storage, source, or chat. Configure an X developer-console spending limit, then set a daily request cap in Advisor. Default cap is zero. No paid requests run automatically.

## API

- `GET /api/market`: latest DEX Screener profiles + promoted Solana tokens; up to 30 addresses, highest-liquidity pool per base token.
- `GET /api/market?q=<symbol-or-address>`: Solana-only search. Confirm exact contracts.
- `GET /api/market?addresses=<addresses>`: watchlist batch, up to 30.
- `GET /api/news`: CoinDesk RSS headlines, five-minute best-effort cache.
- `GET /api/portfolio`: authenticated user config, open recorded positions, latest 100 events.
- `POST /api/portfolio`: authenticated same-origin config/record-position/mark-closed actions. Validates input. Position IDs make retries idempotent. No trade execution.
- `GET /api/advisor?address=<mint>`: fresh market screening plus conditional position ceiling. API allocation remains zero while safety is unverified. Frontend can calculate a conditional amount after explicit manual review.
- `POST /api/monitor`: authenticated same-origin position check. Reads exact recorded pools, updates observed peaks, emits one durable event per position and rule. Per-user lock prevents overlapping checks. Closed positions excluded.
- `GET /api/social[?address=<mint>]`: connection state, cached evidence, daily usage. No paid request.
- `POST /api/social` with `{address}`: authenticated same-origin on-demand exact-contract X recent search; max 25 posts, author IDs and engagement counts, 15-minute D1 cache. No user expansions. Includes sample deduplication; does not claim whole-market social velocity. Per-contract lock and atomic per-user UTC daily request cap. Failed attempts conservatively consume the request allowance. Provider billing can differ from request count; enforce dollar spend at X.

All monetary inputs are USD. Access relies on private Sites sign-in. Do not make public with paid integrations without reviewing access and abuse protection.

## Advisor rules

Heuristic screen: liquidity 0/15/25 points; daily volume 0/20; positive hourly change up to 20; buy-count bias 0/20; pool age 0/15. Candidate needs >=65 and no market flags. Paid boosts/social posts add no points. Weights have no validated predictive performance.

Conditional amount = min(total speculative budget × chosen full-loss percent, budget × allocation cap percent, budget − recorded open principal). Missing budget, failed market screen, missing evidence, or unreviewed safety produces zero. The entire suggested principal can be lost; a loss alert is not a guaranteed stop. Inputs and default percentages are user-controlled examples, not an optimization or personalized financial assessment.

Holder concentration, mint/freeze authorities, sellability and liquidity locks are still not automatically verified. Manual safety acknowledgement is explicitly labelled as user review, not a safety certificate. X posts cannot override safety flags or increase position size.

## Positions and alerts

Positions, risk config, observed peaks, X cache/usage and exit events persist in D1 by authenticated user. Entry watchlist/settings/history remain device-local from version 1. Record only manually completed trades with actual entry price and amount; inferred quantity excludes fees. All open exposure must be recorded for the allocation ceiling to be meaningful. Mark a position closed only after manually closing; update the configured budget for realized P&L. Wallet balances and fills are not synced.

Position rules: profit target, loss threshold, trailing pullback from observed peak, liquidity drop from opening snapshot, unavailable price/liquidity. Thresholds are fixed at position creation; default edits affect future positions. One event per rule per position, persisted across reloads. Historical event display does not imply an ongoing condition.

Monitoring runs every 15 seconds only while the mounted dashboard is open and monitoring is enabled. Remains mounted when switching dashboard tabs. Provider snapshots may be delayed; the 10-second best-effort server cache is not a freshness guarantee. Background tabs may be throttled. The opening liquidity snapshot comes from the selected pool data available when recording, not historical entry liquidity. Only observed peaks are known. User notification permission and browser support required for desktop alerts; no successful delivery guarantee.

**Always-on scheduler and mobile push are not configured or implemented in this hosting integration. Closing the app stops monitoring. This version must not be relied upon as an emergency exit system.** A hosted background runner and a delivery channel are required before making that claim. No automated buy/sell transactions are in scope.

## Validation

X cache isolation regression checks: `node --experimental-strip-types --test scripts/check-social-cache.mjs`. These exercise the actual social route handlers with simulated authentication, D1, and provider responses (not live integration tests). Shared cache writes contain public evidence only; legacy cache rows are projected through the same allowlist when read. Quota and connection fields are constructed for the current request. Free cache reads remain available when the paid request cap is zero. No database migration is needed for this fix.

`node --experimental-strip-types scripts/check-research.mjs` checks financial caps, entry vetoes, exact alert boundaries, outage behavior and social sample deduplication. Type check and production build through existing scripts. SQL migration/reservation/lock/event deduplication queries were checked against SQLite. X live API calls require credentials and were not exercised. No browser QA performed.

## Provider documentation

- https://docs.dexscreener.com/api/reference
- https://docs.phantom.com/developer-powertools/token-pages
- https://docs.x.com/x-api/getting-started/pricing
- https://developers.cloudflare.com/workers/configuration/cron-triggers/
