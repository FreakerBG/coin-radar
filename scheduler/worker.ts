// Standalone Cloudflare Worker proof of concept. No Cron Trigger is configured in
// scheduler/wrangler.jsonc, and SCAN_ENABLED must be exactly "true" before any
// outbound request can be made. Do not enable it until detection is separated
// from the daily outcome pipeline (docs/15-minute-scanner-plan.md in PR #22).

export type SchedulerEnv = {
  SCAN_ENABLED?: string;
  GOLDMINE_CRON_SECRET?: string;
};

export type ScanResult = 'disabled' | 'checked' | 'busy' | 'provider_unavailable';

const SCAN_ENDPOINT = 'https://coin-radar-rosy.vercel.app/api/goldmine/scheduled';
const REQUEST_TIMEOUT_MS = 90_000;

export async function runScheduledScan(env: SchedulerEnv, fetcher: typeof fetch = fetch): Promise<ScanResult> {
  if (env.SCAN_ENABLED !== 'true') return 'disabled';

  const secret = env.GOLDMINE_CRON_SECRET;
  if (!secret || secret.trim() !== secret) throw new Error('Scheduler secret is not configured.');

  let response: Response;
  try {
    response = await fetcher(SCAN_ENDPOINT, {
      method: 'POST',
      headers: {'x-goldmine-cron-secret': secret},
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'error',
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
  const status = body && typeof body === 'object' && 'status' in body ? body.status : null;
  if (status === 'checked' || status === 'busy' || status === 'provider_unavailable') return status;
  throw new Error('Scheduler response had an unknown status.');
}

const scheduler = {
  async scheduled(_controller: ScheduledController, env: SchedulerEnv): Promise<void> {
    const status = await runScheduledScan(env);
    // A 200/busy or provider_unavailable is not counted as a successful scan.
    console.log(`coin_radar.scan_scheduler status=${status}`);
  },
};

export default scheduler;
