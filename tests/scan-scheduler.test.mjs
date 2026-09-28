import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runScheduledScan} from '../scheduler/worker.ts';

const secret = 'unit-test-secret';
const enabled = {SCAN_ENABLED: 'true', GOLDMINE_CRON_SECRET: secret};

test('the proof of concept is inert by default, even with a secret', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; throw new Error('Unexpected request'); };
  assert.equal(await runScheduledScan({GOLDMINE_CRON_SECRET: secret}, fetcher), 'disabled');
  assert.equal(await runScheduledScan({SCAN_ENABLED: 'TRUE', GOLDMINE_CRON_SECRET: secret}, fetcher), 'disabled');
  assert.equal(calls, 0);
});

test('enabled scheduler fails closed before fetch when its secret is absent or malformed', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; throw new Error('Unexpected request'); };
  for (const value of [undefined, '', ' trailing ']) {
    await assert.rejects(runScheduledScan({SCAN_ENABLED: 'true', GOLDMINE_CRON_SECRET: value}, fetcher), /secret is not configured/);
  }
  assert.equal(calls, 0);
});

test('enabled scheduler uses only the fixed HTTPS endpoint and custom secret header', async () => {
  let calls = 0;
  const result = await runScheduledScan(enabled, async (url, init) => {
    calls++;
    assert.equal(url, 'https://coin-radar-rosy.vercel.app/api/goldmine/scheduled');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['x-goldmine-cron-secret'], secret);
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    return Response.json({status: 'checked', tracking: {newSignals: 1}});
  });
  assert.equal(result, 'checked');
  assert.equal(calls, 1);
});

test('busy and provider failures are not reported as checked', async () => {
  for (const status of ['busy', 'provider_unavailable']) {
    assert.equal(await runScheduledScan(enabled, async () => Response.json({status})), status);
  }
});

test('HTTP failures, malformed JSON and unknown statuses fail without retrying', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return new Response('sensitive response', {status: 503}); };
  await assert.rejects(runScheduledScan(enabled, fetcher), error => {
    assert.match(error.message, /HTTP 503/);
    assert.ok(!error.message.includes('sensitive response'));
    return true;
  });
  assert.equal(calls, 1);
  await assert.rejects(runScheduledScan(enabled, async () => new Response('not json')), /response was invalid/);
  await assert.rejects(runScheduledScan(enabled, async () => Response.json({status: 'other'})), /unknown status/);
});

test('network errors do not leak the secret or their original message', async () => {
  await assert.rejects(runScheduledScan(enabled, async () => { throw new Error(`network error ${secret}`); }), error => {
    assert.equal(error.message, 'Scheduler request failed.');
    assert.ok(!error.message.includes(secret));
    return true;
  });
});
