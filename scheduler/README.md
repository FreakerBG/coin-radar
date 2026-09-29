# Scan scheduler (Cloudflare Worker, dormant as shipped)

For the owner operating the optional intraday detector. The daily Vercel Cron (`GET /api/goldmine/scheduled`,
`0 0 * * *`) stays the only full scan and the only outcome settlement; this Worker only ever sends the
detection-only `POST`, which never settles outcomes.

## What it is

- `worker.ts` is the entry module. It has a `scheduled()` handler and **no `fetch()` handler**. With
  `workers_dev: false`, `preview_urls: false` and no routes it has no public URL at all.
- `scan.ts` holds the logic. It makes one `POST` to the fixed `https://coin-radar-rosy.vercel.app/api/goldmine/scheduled`
  with `x-goldmine-cron-secret` and `x-vercel-protection-bypass`. It uses `redirect: 'error'`, a 90 s timeout,
  one attempt and no retry, and calls `controller.noRetry()` so the platform does not retry either.
- Every run logs one JSON line, `coin_radar.scan_scheduler`, with `status` (`disabled`, `checked`, `busy`,
  `provider_unavailable` or `error`) plus counts: new signals, duration, contract-safety coverage and alerts
  queued. The line never contains a secret, an address or a response body. A 200 with `busy` or
  `provider_unavailable` is logged as exactly that.
- `wrangler.jsonc` ships with `triggers.crons: []` and `SCAN_ENABLED: "false"`.

## Secrets (never typed, pasted or printed)

| Name | Where | Purpose |
| --- | --- | --- |
| `GOLDMINE_CRON_SECRET` | Vercel production env (sensitive) **and** Worker secret | The app's scheduler credential (`lib/goldmine/scheduled-auth.ts`). |
| `VERCEL_BYPASS_SECRET` | A dedicated Vercel Protection Bypass entry (note `cloudflare-scan-scheduler`) **and** Worker secret | Production `.vercel.app` URLs are behind Vercel Authentication. Without the bypass, the request never reaches the app. |

`node scheduler/provision-secrets.mjs` generates both, puts them in both managers over stdin and prints
only `ok` lines. Vercel applies `GOLDMINE_CRON_SECRET` to the **next** production deployment.

## Deploy order

1. `npx wrangler login` (owner, interactive), then `npx wrangler whoami`. Check the account's plan in the
   dashboard: Free allows 100k requests/day, 10 ms CPU per invocation, 5 cron triggers per account and a
   15-minute wall time for a scheduled invocation.
2. `npx wrangler deploy --config scheduler/wrangler.jsonc`, dormant: no trigger, `SCAN_ENABLED=false`.
3. `node scheduler/provision-secrets.mjs`, then let the next production deployment pick up the Vercel variable.
4. Check that unauthorized calls still fail. Through the bypass (`vercel curl ... --scope vibe-code22`),
   `POST /api/goldmine/scheduled` with no secret or a wrong secret must return the app's 401.
5. Non-scanning test in the real account: Workers & Pages -> this Worker -> Settings -> Trigger Events, or
   `npx wrangler dev --config scheduler/wrangler.jsonc --test-scheduled` and `GET /__scheduled` locally.
   With `SCAN_ENABLED=false` the log line must say `"status":"disabled"` and no request may be made.

## Enabling (only after the activation gates in docs/capacity-96-per-day.md)

Deploy a separate, uncommitted config (the committed file stays dormant) with
`"vars": {"SCAN_ENABLED": "true", "SCAN_UNTIL": "<ISO instant, UTC, ending in Z>"}` and a conservative first
cadence such as `"crons": ["0 * * * *"]` (hourly). `SCAN_UNTIL` is required: without a valid deadline no more
than 7 days ahead the Worker stays `disabled`, and after it the Worker logs `expired` and sends nothing. That
makes every enabled configuration end on its own, even if nobody turns it off. Move to `*/15 * * * *` only
once hourly runs have shown `checked`, acceptable `durationMs`, safety coverage, a `pairs24h` inside the
capacity gate (docs/capacity-96-per-day.md) and flat Turso usage. Past runs: dashboard -> Trigger Events
(last 100) and Workers Logs; the app's `coin_radar.scan_outcome` lines in Vercel are kept for one hour on Hobby.

## Kill switch (fastest first)

| Action | Effect | Takes effect |
| --- | --- | --- |
| Deploy with `"SCAN_ENABLED": "false"` (the committed file) | Every trigger becomes a logged no-op | Immediately for new invocations (new Worker version) |
| Revoke the `cloudflare-scan-scheduler` bypass in Vercel project settings | Requests stop at Vercel Authentication | Expected immediately (checked at the edge); confirm with one probe |
| Remove `GOLDMINE_CRON_SECRET` from Vercel and redeploy | The app answers 401 | Next production deployment |
| Deploy with `"crons": []` (the committed file) | No further scheduled events | Up to 15 minutes to propagate (Cloudflare docs) |

Deploying the committed `wrangler.jsonc` does the first and last together. The daily Vercel GET is
unaffected by all four and keeps settling d1/d3/d7 outcomes.
