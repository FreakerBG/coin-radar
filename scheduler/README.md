# Scan scheduler proof of concept (inactive)

This is a **separate** Cloudflare Worker. It is not deployed, has no `triggers.crons`, exposes no HTTP handler, and makes no outbound request unless `SCAN_ENABLED` is exactly `true` and a nonempty `GOLDMINE_CRON_SECRET` is configured. Do not add a trigger or enable it yet. The current Vercel daily Cron remains the only unattended scan.

The request path is fixed to Coin Radar's production `POST /api/goldmine/scheduled` and uses the existing `x-goldmine-cron-secret` authorization convention. The Worker does not accept a caller-supplied URL, follow redirects, retry, or log secrets or response bodies. It distinguishes `checked`, `busy`, and `provider_unavailable`, because an HTTP 200 alone is not proof of a successful scan. The secret must be configured independently in Cloudflare and Vercel through their secret managers; never copy it into this repository or a shell transcript.

`npm test` includes offline mocked tests for the scheduler. `npx wrangler deploy --dry-run --config scheduler/wrangler.jsonc` can validate the bundle locally; **do not use an actual deploy command** in this stage.

Activation is blocked on the go/no-go gates in [the 15-minute scanner plan](https://github.com/FreakerBG/coin-radar/pull/22) (draft PR #22): separate detection from daily outcome settlement, bound signal storage and provider calls, and test an observable rollback. The code in this directory is not an authorization to turn on `*/15 * * * *` or to set `SCAN_ENABLED=true` in a live Worker.
