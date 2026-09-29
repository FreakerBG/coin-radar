// The scheduler Worker's ENABLED path in Cloudflare's actual runtime (workerd, via Miniflare), not Node.
// tests/scan-scheduler.test.mjs runs the same logic under Node's fetch, which accepts options workerd
// rejects: the 2026-09-29 production canary failed before sending anything because workerd refuses
// `redirect: 'error'`. Here the real bundle of scheduler/worker.ts runs in workerd with the committed
// compatibility date, and every outbound fetch is answered by a local mock through Miniflare's
// outboundService - no network, no Cloudflare or Vercel account. Secrets below are test values.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {after, describe, test} from 'node:test';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';

const root = new URL('../', import.meta.url);
const config = JSON.parse(readFileSync(new URL('scheduler/wrangler.jsonc', root), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
const CRON_SECRET = 'workerd-test-cron-secret-0123456789abcdef';
const BYPASS_SECRET = 'WorkerdTestBypassSecret012345678';
const ENDPOINT = 'https://coin-radar-rosy.vercel.app/api/goldmine/scheduled';

const bundle = (await build({
  entryPoints: [new URL('scheduler/worker.ts', root).pathname.replace(/^\/(\w:)/, '$1')],
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', write: false, logLevel: 'silent',
})).outputFiles[0].text;

const running = [];
after(async () => { await Promise.all(running.map(mf => mf.dispose())); });

// Runs one scheduled event against `respond` (the mock origin). Returns the event result, every outbound
// request the Worker made, and everything the runtime wrote to stdout/stderr.
async function runScheduled(respond, bindings = {SCAN_ENABLED: 'true', GOLDMINE_CRON_SECRET: CRON_SECRET, VERCEL_BYPASS_SECRET: BYPASS_SECRET}) {
  const requests = [];
  let output = '';
  const mf = new Miniflare({
    modules: true,
    script: bundle,
    compatibilityDate: config.compatibility_date,
    bindings,
    outboundService: async request => {
      requests.push({url: request.url, method: request.method, cron: request.headers.get('x-goldmine-cron-secret'), bypass: request.headers.get('x-vercel-protection-bypass')});
      return respond(request);
    },
    handleRuntimeStdio(stdout, stderr) {
      stdout.on('data', chunk => { output += chunk; });
      stderr.on('data', chunk => { output += chunk; });
    },
  });
  running.push(mf);
  const worker = await mf.getWorker();
  const result = await worker.scheduled({cron: '55 9 29 9 *', scheduledTime: new Date('2026-09-29T09:55:00Z')});
  await new Promise(resolve => setTimeout(resolve, 300)); // let the runtime's stdout drain
  const line = output.split('\n').find(text => text.includes('coin_radar.scan_scheduler'));
  const record = line ? JSON.parse(line.slice(line.indexOf('{'))) : null;
  return {result, requests, output, record};
}

const noSecrets = output => {
  assert.equal(output.includes(CRON_SECRET), false, 'the cron secret never appears in runtime output');
  assert.equal(output.includes(BYPASS_SECRET), false, 'the bypass secret never appears in runtime output');
};

describe('scheduler Worker enabled path in workerd', () => {
  test('a 200 with status checked succeeds: one POST to the fixed endpoint carrying both secrets, logged as counts only', async () => {
    const {result, requests, output, record} = await runScheduled(() => Response.json({
      status: 'checked', candidates: [{address: 'MockMintAddress1111111111111111111111111'}], opportunities: 0,
      tracking: {newSignals: 1, outcomes: null}, alerts: {queued: 0, delivery: 'not_configured'},
      safety: {eligible: 1, verified: 0, unsafe: 0, unavailable: 1, requests: 1, cacheHits: 0, rateLimited: false, cooldown: 'none', unchecked: 0},
    }));
    assert.equal(result.outcome, 'ok');
    assert.equal(result.noRetry, true, 'the platform is told never to retry a scheduled run');
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0], {url: ENDPOINT, method: 'POST', cron: CRON_SECRET, bypass: BYPASS_SECRET});
    assert.equal(record.status, 'checked');
    assert.equal(record.newSignals, 1);
    assert.equal(record.outcomesSettled, false);
    assert.deepEqual(record.safety, {eligible: 1, verified: 0, unsafe: 0, unavailable: 1, requests: 1, rateLimited: false, cooldown: 'none'});
    assert.equal(output.includes('MockMintAddress'), false, 'no candidate data is logged');
    noSecrets(output);
  });

  test('a 3xx is not followed and fails: exactly one request, logged as an error with the status only', async () => {
    for (const status of [302, 307]) {
      const {result, requests, output, record} = await runScheduled(() => new Response('<html>login page</html>', {status, headers: {location: 'https://vercel.com/sso-api?url=elsewhere'}}));
      assert.equal(result.outcome, 'exception');
      assert.equal(result.noRetry, true);
      assert.equal(requests.length, 1, `the ${status} Location is never requested`);
      assert.equal(requests[0].url, ENDPOINT);
      assert.deepEqual([record.status, record.message], ['error', `Scheduler endpoint returned HTTP ${status}.`]);
      assert.equal(output.includes('login page'), false, 'no response body is logged');
      noSecrets(output);
    }
  });

  test('a non-200 success-family or error status fails; the body is never logged', async () => {
    for (const status of [201, 204, 401, 503]) {
      const {result, requests, record, output} = await runScheduled(() => new Response(status === 204 ? null : 'sensitive body', {status}));
      assert.equal(result.outcome, 'exception');
      assert.equal(requests.length, 1);
      assert.equal(record.message, `Scheduler endpoint returned HTTP ${status}.`);
      assert.equal(output.includes('sensitive body'), false);
      noSecrets(output);
    }
  });

  test('the committed dormant setting sends nothing even with both secrets present', async () => {
    const {result, requests, record} = await runScheduled(() => { throw new Error('must not be called'); }, {SCAN_ENABLED: config.vars.SCAN_ENABLED, GOLDMINE_CRON_SECRET: CRON_SECRET, VERCEL_BYPASS_SECRET: BYPASS_SECRET});
    assert.equal(config.vars.SCAN_ENABLED, 'false');
    assert.equal(result.outcome, 'ok');
    assert.equal(requests.length, 0);
    assert.equal(record.status, 'disabled');
  });
});
