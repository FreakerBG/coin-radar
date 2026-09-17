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
- `POST /api/portfolio`: authenticated same-origin config/record-position/mark-closed actions. Validates input. Position IDs make retries idempotent. The 30 open-position limit is applied atomically. No trade execution.
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

Node 22.13 or newer. Run `npm ci` first.

| Command | Runs |
| --- | --- |
| `npm run verify` | `typecheck`, `lint`, `test`, `build` in that order; stops at the first failure. |
| `npm run typecheck` | `tsc --noEmit` without writing `tsconfig.tsbuildinfo`. |
| `npm run lint` | ESLint. Violations that existed before Stage 02 are recorded in `eslint-suppressions.json`; any new violation fails. |
| `npm test` | All offline tests in `tests/` (Node test runner). |
| `npm run test:research` | Advisor and market logic only. Also `node --experimental-strip-types scripts/check-research.mjs`. |
| `npm run test:social-cache` | X cache isolation only. Also `node --experimental-strip-types --test scripts/check-social-cache.mjs`. |
| `npm run test:browser` | Playwright smoke tests (not part of `verify`). Needs Chromium: `npx playwright install chromium`. |

Test groups:

- `advisor.test.mjs`: position sizing vetoes, caps, cent rounding and settings boundaries; exact loss, profit, trailing and liquidity thresholds (equality triggers each rule); unavailable price/liquidity; observed peaks; social sample summary.
- `market.test.mjs`: input sanitizing, pair normalization, every score and warning boundary, verdicts, safe links; paid promotion never changes the result.
- `social-cache.test.mjs`: two users sharing one cache row, legacy row projection, per-request quota and connection state, fresh/stale/zero-cap paths, removed credential, atomic quota, provider failure and malformed responses, contract lock release, auth and same-origin guards.
- `portfolio-route.test.mjs`, `advisor-route.test.mjs`, `monitor-route.test.mjs`, `research-db.test.mjs`: auth, same-origin, validation, per-user isolation, idempotent recording, the 30-position limit, zero API allocation, social exclusion, per-user monitor locks, durable event deduplication, outages and lock release.

Route tests run the real route handlers and `lib/research-db.ts` against an in-memory SQLite database built from `drizzle/0000_rare_terror.sql`, through a D1-shaped adapter. Only runtime boundaries are replaced: Cloudflare `env`, Sites authentication headers and `fetch`. DEX Screener, CoinDesk and X responses are fixtures. No test makes a network request, uses real credentials or touches production D1; no live X request is made.

Browser smoke (`e2e/`) starts the local dev server (mock Sites sign-in, local Miniflare) and fulfils every `/api/*` call in the browser from fixtures, aborting any non-local request. It covers initial render, provider outage, tab switching, device-local watchlist/alert settings, signed-out and unavailable Advisor account states, and horizontal overflow at 360 and 390 px. It does not cover authenticated D1 flows, real providers or production hosting. At 320 px the tab strip still overflows by about 8 px.

Known limitations, not changed in Stage 02:

- Monitor and social locks expire after 60 seconds. A scan longer than that can overlap the next; event IDs prevent duplicate events, but overlapping scans can write an older observed peak.
- Configuration saves are last-writer-wins across tabs. `revision` columns are incremented but not checked.
- Failed paid X attempts consume the reserved request, by design. The daily cap uses the UTC date.
- A market score of 64.5 displays as 65 but stays `Watch`; the verdict uses the unrounded score. Allocation rounding can land one cent below an exact cent value, never above.
- No migration is required for Stage 02.

## Provider documentation

- https://docs.dexscreener.com/api/reference
- https://docs.phantom.com/developer-powertools/token-pages
- https://docs.x.com/x-api/getting-started/pricing
- https://developers.cloudflare.com/workers/configuration/cron-triggers/
