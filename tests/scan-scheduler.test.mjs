// scheduler/worker.ts + scheduler/scan.ts: the Cloudflare Worker that triggers the detection-only POST. Offline: every fetch is
// a local double, and no Cloudflare or Vercel account is contacted.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import './helpers/harness.mjs'; // registers the extensionless-import loader the Worker's './scan' import needs

const {default: worker} = await import('../scheduler/worker.ts');
const {handleScheduled, runScheduledScan, REQUEST_TIMEOUT_MS, SCAN_ENDPOINT} = await import('../scheduler/scan.ts');

const secret = 'unit-test-secret';
const bypass = 'unitTestBypassSecret0123456789ab';
const enabled = {SCAN_ENABLED: 'true', GOLDMINE_CRON_SECRET: secret, VERCEL_BYPASS_SECRET: bypass};
const controller = (noRetry = () => {}) => ({cron: '*/15 * * * *', scheduledTime: 1_790_000_000_000, noRetry});

function captureLogs(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  return Promise.resolve().then(fn).finally(() => { console.log = original; }).then(() => lines, error => { error.lines = lines; throw error; });
}

test('inert by default, even with both secrets', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; throw new Error('Unexpected request'); };
  assert.deepEqual(await runScheduledScan({GOLDMINE_CRON_SECRET: secret, VERCEL_BYPASS_SECRET: bypass}, fetcher), {status: 'disabled'});
  assert.deepEqual(await runScheduledScan({...enabled, SCAN_ENABLED: 'TRUE'}, fetcher), {status: 'disabled'});
  assert.deepEqual(await runScheduledScan({...enabled, SCAN_ENABLED: 'false'}, fetcher), {status: 'disabled'});
  assert.equal(calls, 0);
});

test('the shipped wrangler config has no cron trigger, SCAN_ENABLED "false", no workers.dev or preview URL', () => {
  const config = JSON.parse(readFileSync(new URL('../scheduler/wrangler.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  assert.deepEqual(config.triggers, {crons: []});
  assert.equal(config.vars.SCAN_ENABLED, 'false');
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
});

test('there is no HTTP handler, and the entry module exports nothing but its default handler (workerd rejects value exports)', async () => {
  assert.deepEqual(Object.keys(worker), ['scheduled']);
  assert.deepEqual(Object.keys(await import('../scheduler/worker.ts')), ['default']);
});

test('enabled but missing or malformed secrets fail closed before any request', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; throw new Error('Unexpected request'); };
  for (const override of [{GOLDMINE_CRON_SECRET: undefined}, {GOLDMINE_CRON_SECRET: ''}, {GOLDMINE_CRON_SECRET: ' padded '}, {VERCEL_BYPASS_SECRET: undefined}, {VERCEL_BYPASS_SECRET: ''}]) {
    await assert.rejects(runScheduledScan({...enabled, ...override}, fetcher), /secret is not configured/);
  }
  assert.equal(calls, 0);
});

test('one request to the fixed HTTPS endpoint, with both secret headers, no redirects, a bounded timeout', async () => {
  let calls = 0;
  await runScheduledScan(enabled, async (url, init) => {
    calls++;
    assert.equal(url, 'https://coin-radar-rosy.vercel.app/api/goldmine/scheduled');
    assert.equal(SCAN_ENDPOINT.startsWith('https://'), true);
    assert.equal(init.method, 'POST');
    assert.deepEqual(init.headers, {'x-goldmine-cron-secret': secret, 'x-vercel-protection-bypass': bypass});
    assert.equal(init.redirect, 'manual', 'workerd rejects "error"; "manual" returns a redirect unfollowed');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.body, undefined);
    return Response.json({status: 'checked'});
  });
  assert.equal(calls, 1);
  assert.ok(REQUEST_TIMEOUT_MS > 0 && REQUEST_TIMEOUT_MS < 300_000);
});

test('a checked response is summarized as counts and enums only; addresses and provider text are dropped', async () => {
  let t = 1000;
  const summary = await runScheduledScan(enabled, async () => Response.json({
    status: 'checked', candidates: [{address: 'SecretMintAddress111', snapshot: {symbol: 'X'}}], opportunities: 1,
    tracking: {newSignals: 1, outcomes: null}, alerts: {queued: 1, delivery: 'not_configured'},
    safety: {eligible: 1, verified: 1, unsafe: 0, unavailable: 0, requests: 1, cacheHits: 0, rateLimited: false, cooldown: 'none', unchecked: 0},
    warnings: ['provider said something'],
  }), () => (t += 250));
  assert.deepEqual(summary, {
    status: 'checked', httpStatus: 200, durationMs: 250, newSignals: 1, outcomesSettled: false, candidates: 1, opportunities: 1, alertsQueued: 1,
    safety: {eligible: 1, verified: 1, unsafe: 0, unavailable: 0, requests: 1, rateLimited: false, cooldown: 'none'},
  });
  assert.equal(JSON.stringify(summary).includes('SecretMint'), false);
});

test('busy and provider_unavailable are reported as themselves, never as checked', async () => {
  for (const status of ['busy', 'provider_unavailable']) {
    assert.equal((await runScheduledScan(enabled, async () => Response.json({status, candidates: []}))).status, status);
  }
});

test('HTTP failures (including an SSO redirect returned as a 3xx), malformed JSON and unknown statuses fail after one attempt', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return new Response('sensitive response', {status: 503}); };
  await assert.rejects(runScheduledScan(enabled, fetcher), error => {
    assert.match(error.message, /HTTP 503/);
    assert.ok(!error.message.includes('sensitive response'));
    return true;
  });
  assert.equal(calls, 1);
  // With redirect: 'manual' a redirect is handed back, not followed; it must fail like any non-200.
  for (const status of [301, 302, 303, 307, 308]) {
    let redirectCalls = 0;
    await assert.rejects(runScheduledScan(enabled, async () => { redirectCalls++; return new Response(null, {status, headers: {location: 'https://vercel.com/sso-api'}}); }), new RegExp(`HTTP ${status}`));
    assert.equal(redirectCalls, 1);
  }
  await assert.rejects(runScheduledScan(enabled, async () => { throw new TypeError('network error'); }), /^Error: Scheduler request failed\.$/);
  await assert.rejects(runScheduledScan(enabled, async () => new Response('not json')), /response was invalid/);
  await assert.rejects(runScheduledScan(enabled, async () => Response.json({status: 'other'})), /unknown status/);
});

test('network errors never leak either secret or their original message', async () => {
  await assert.rejects(runScheduledScan(enabled, async () => { throw new Error(`network error ${secret} ${bypass}`); }), error => {
    assert.equal(error.message, 'Scheduler request failed.');
    return true;
  });
});

test('scheduled(): calls noRetry, logs one JSON line per run - including failures - with no secret', async () => {
  let noRetry = 0;
  const ok = await captureLogs(() => handleScheduled(controller(() => noRetry++), enabled, async () => Response.json({status: 'busy', candidates: []})));
  assert.equal(noRetry, 1);
  assert.equal(ok.length, 1);
  assert.deepEqual(JSON.parse(ok[0]).status, 'busy');

  const failed = await captureLogs(() => handleScheduled(controller(() => noRetry++), enabled, async () => { throw new Error(secret); })).catch(error => error.lines);
  assert.equal(noRetry, 2, 'the platform is told not to retry a failed run');
  assert.equal(failed.length, 1);
  assert.deepEqual([JSON.parse(failed[0]).status, JSON.parse(failed[0]).message], ['error', 'Scheduler request failed.']);
  for (const line of [...ok, ...failed]) {
    assert.equal(line.includes(secret), false);
    assert.equal(line.includes(bypass), false);
  }

  const off = await captureLogs(() => handleScheduled(controller(), {SCAN_ENABLED: 'false'}, async () => { throw new Error('Unexpected request'); }));
  assert.equal(JSON.parse(off[0]).status, 'disabled');
});
