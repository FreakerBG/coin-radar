// Logic for the standalone Cloudflare Worker (scheduler/worker.ts) that triggers Coin Radar's detection-only scan
// (POST /api/goldmine/scheduled on the Vercel production deployment). It has a scheduled() handler and
// no fetch() handler, so it serves nothing over HTTP. It makes no outbound request unless SCAN_ENABLED is
// exactly "true" and both secrets are configured. scheduler/wrangler.jsonc ships with no cron trigger and
// SCAN_ENABLED "false"; turning it on is an explicit, reviewed configuration change (scheduler/README.md).
//
// Why two secrets:
//   GOLDMINE_CRON_SECRET  the application's own scheduler credential (lib/goldmine/scheduled-auth.ts,
//                         header x-goldmine-cron-secret). Without it the app answers 401.
//   VERCEL_BYPASS_SECRET  a Protection Bypass for Automation secret dedicated to this Worker. Production
//                         .vercel.app URLs sit behind Vercel Authentication (deployment protection); without
//                         the bypass header the request never reaches the application and Vercel redirects
//                         to its login page (a 3xx, which is never followed and fails the HTTP 200 check).
//                         Revocable on its own, independent of every other bypass secret.
//
// Safety properties (tests/scan-scheduler.test.mjs, and in the real workerd runtime
// tests/scheduler-workerd.test.mjs): fixed HTTPS origin and path; no caller-supplied URL;
// no redirects followed; one attempt, never a retry, and controller.noRetry() so the platform does not
// retry a failed invocation into a rate limit either; a bounded timeout; errors and logs never contain a
// secret, a URL with credentials or a response body - only the status and counts.

export type SchedulerEnv = {
  SCAN_ENABLED?: string;
  GOLDMINE_CRON_SECRET?: string;
  VERCEL_BYPASS_SECRET?: string;
};

export type ScanResult = 'disabled' | 'checked' | 'busy' | 'provider_unavailable';

// Counts and enums from the scan response, validated one by one. Nothing else from the body is kept.
export type ScanSummary = {
  status: ScanResult;
  httpStatus?: number;
  durationMs?: number;
  newSignals?: number;
  candidates?: number;
  opportunities?: number;
  outcomesSettled?: boolean;
  alertsQueued?: number | null;
  safety?: {eligible: number; verified: number; unsafe: number; unavailable: number; requests: number; rateLimited: boolean; cooldown: string};
};

export const SCAN_ENDPOINT = 'https://coin-radar-rosy.vercel.app/api/goldmine/scheduled';
// Well above a normal detection (seconds) and below Vercel's 300 s function limit. If it fires, the
// application run continues and keeps holding its lock, so the next trigger reports `busy`, not a second scan.
export const REQUEST_TIMEOUT_MS = 90_000;

const COOLDOWN_STATES = ['none', 'active', 'unknown', 'disabled', 'not_read'];
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
const usableSecret = (value: string | undefined): value is string => typeof value === 'string' && value.length > 0 && value.trim() === value;

function summarize(status: ScanResult, body: Record<string, unknown>, httpStatus: number, durationMs: number): ScanSummary {
  const summary: ScanSummary = {status, httpStatus, durationMs};
  const tracking = body.tracking as Record<string, unknown> | undefined;
  if (tracking && typeof tracking === 'object') {
    summary.newSignals = count(tracking.newSignals);
    summary.outcomesSettled = tracking.outcomes !== null && tracking.outcomes !== undefined;
  }
  if (Array.isArray(body.candidates)) summary.candidates = body.candidates.length;
  summary.opportunities = count(body.opportunities);
  const alerts = body.alerts as Record<string, unknown> | undefined;
  if (alerts && typeof alerts === 'object') summary.alertsQueued = alerts.queued === null ? null : count(alerts.queued);
  const safety = body.safety as Record<string, unknown> | undefined;
  if (safety && typeof safety === 'object') {
    const numbers = ['eligible', 'verified', 'unsafe', 'unavailable', 'requests'].map(key => count(safety[key]));
    if (numbers.every(n => n !== undefined) && typeof safety.rateLimited === 'boolean' && COOLDOWN_STATES.includes(String(safety.cooldown))) {
      const [eligible, verified, unsafe, unavailable, requests] = numbers as number[];
      summary.safety = {eligible, verified, unsafe, unavailable, requests, rateLimited: safety.rateLimited, cooldown: String(safety.cooldown)};
    }
  }
  return summary;
}

export async function runScheduledScan(env: SchedulerEnv, fetcher: typeof fetch = fetch, clock: () => number = Date.now): Promise<ScanSummary> {
  if (env.SCAN_ENABLED !== 'true') return {status: 'disabled'};
  if (!usableSecret(env.GOLDMINE_CRON_SECRET) || !usableSecret(env.VERCEL_BYPASS_SECRET)) throw new Error('Scheduler secret is not configured.');

  const started = clock();
  let response: Response;
  try {
    response = await fetcher(SCAN_ENDPOINT, {
      method: 'POST',
      headers: {'x-goldmine-cron-secret': env.GOLDMINE_CRON_SECRET, 'x-vercel-protection-bypass': env.VERCEL_BYPASS_SECRET},
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // 'manual', never 'error': workerd rejects redirect: 'error' outright ("won't be implemented ... use
      // 'manual' and check the response status code"), which failed the 2026-09-29 production canary before
      // any request was sent. With 'manual' a redirect comes back as its own 3xx response and is never
      // followed, so the status check below rejects it like every other non-200.
      redirect: 'manual',
    });
  } catch {
    // No URL, response body, or secret in logs or propagated errors.
    throw new Error('Scheduler request failed.');
  }
  if (response.status !== 200) throw new Error(`Scheduler endpoint returned HTTP ${response.status}.`);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('Scheduler response was invalid.');
  }
  const status = body && typeof body === 'object' && 'status' in body ? (body as {status: unknown}).status : null;
  if (status === 'checked' || status === 'busy' || status === 'provider_unavailable') return summarize(status, body as Record<string, unknown>, response.status, clock() - started);
  throw new Error('Scheduler response had an unknown status.');
}

// One JSON line per invocation, success or failure, so Workers Logs can count checked/busy/
// provider_unavailable/disabled/error across a day. A 200 with `busy` or `provider_unavailable` is logged as
// exactly that, never as a successful scan.
export async function handleScheduled(controller: Pick<ScheduledController, 'cron' | 'scheduledTime'> & {noRetry?: () => void}, env: SchedulerEnv, fetcher: typeof fetch = fetch): Promise<void> {
  controller.noRetry?.();
  try {
    const summary = await runScheduledScan(env, fetcher);
    console.log(JSON.stringify({event: 'coin_radar.scan_scheduler', cron: controller.cron, scheduledTime: controller.scheduledTime, ...summary}));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Scheduler failed.';
    console.log(JSON.stringify({event: 'coin_radar.scan_scheduler', cron: controller.cron, scheduledTime: controller.scheduledTime, status: 'error', message}));
    throw error;
  }
}
