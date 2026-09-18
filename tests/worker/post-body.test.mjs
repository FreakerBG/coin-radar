// Real built-Worker regression for POST request bodies (run `npm run build` first; `npm run test:worker`).
// Under `wrangler dev`, a response sent while a POST body was still unread made the dev proxy log an
// uncaught "Can't read from request stream after response has been sent"; the next request then got
// Wrangler's 503 "worker restarted mid-request" or hung on the kept-alive connection. This sends
// small bodies through HTTP to the built Worker, with fake local sign-in headers and a temporary
// local D1, and checks every response, a follow-up request after each, liveness and the log.
// The requests used here all end before any provider call; the X credential is a fake local value.
import assert from 'node:assert/strict';
import {after, before, describe, test} from 'node:test';
import {startBuiltWorker} from '../helpers/built-worker.mjs';

const STREAM_ERROR = "Can't read from request stream after response has been sent";
const RESTARTED = 'Your worker restarted mid-request';
const signedIn = {'oai-authenticated-user-id': 'local-worker-test', 'oai-authenticated-user-email': 'worker-test@example.test'};
const config = {bankroll: 1000, riskPct: 2, maxAllocationPct: 5, takeProfitPct: 40, stopPct: 20, trailingPct: 15, liquidityDropPct: 30, xDailyRequests: 5};

async function send(worker, method, path, {headers = {}, body} = {}) {
  const response = await fetch(worker.origin + path, {method, headers, body, signal: AbortSignal.timeout(8000)});
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return {status: response.status, json};
}

// Each POST is followed by a signed-in health check on the same kept-alive connection pool. The
// counts let the last test confirm that every POST really had a healthy follow-up.
const followUps = {posts: 0, healthy: 0};
async function postThenHealth(worker, {path, auth = true, origin = 'same', contentType = 'application/json', body}, expected) {
  followUps.posts++;
  const headers = {'content-type': contentType, ...(auth ? signedIn : {})};
  if (origin === 'same') headers.origin = worker.origin;
  else if (origin) headers.origin = origin;
  const response = await send(worker, 'POST', path, {headers, body});
  if (typeof expected.json === 'function') {
    assert.equal(response.status, expected.status, `POST ${path}: ${JSON.stringify(response.json)}`);
    expected.json(response.json);
  } else {
    assert.deepEqual(response, expected, `POST ${path}`);
  }
  const health = await send(worker, 'GET', '/api/health', {headers: signedIn});
  assert.equal(health.status, 200, `follow-up health after POST ${path}: ${JSON.stringify(health.json)}`);
  assert.deepEqual([health.json.status, health.json.storage, health.json.schema], ['ok', 'ok', 'compatible']);
  assert.equal(worker.alive, true, `the Worker is still running after POST ${path}`);
  if (health.status === 200 && health.json.status === 'ok' && worker.alive) followUps.healthy++;
}

// The error is printed only at debug level, and in Wrangler's dev proxy; a log without the proxy's
// debug output could not show it.
function assertCleanLog(worker) {
  assert.ok(worker.log.includes('[wrangler-ProxyWorker:info] GET /api/health 200'), 'the Worker log is captured at debug level');
  assert.equal(worker.log.includes(STREAM_ERROR), false, `the Worker log contains the uncaught stream error:\n${worker.log.split('\n').filter(line => line.includes(STREAM_ERROR)).slice(0, 5).join('\n')}`);
  assert.equal(worker.log.includes(RESTARTED), false, 'Wrangler reported a restarted Worker');
}

test('the log check recognizes the uncaught stream error', () => {
  const debugLine = '[wrangler-ProxyWorker:info] GET /api/health 200 OK (5ms)\n';
  assert.doesNotThrow(() => assertCleanLog({log: debugLine}));
  assert.throws(() => assertCleanLog({log: debugLine + 'uncaught exception; source = Uncaught (async); stack = TypeError: ' + STREAM_ERROR + '.'}), /uncaught stream error/);
  assert.throws(() => assertCleanLog({log: debugLine + RESTARTED}), /restarted/);
  assert.throws(() => assertCleanLog({log: '[wrangler:info] GET /api/health 200 OK (5ms)'}), /debug level/);
});

const signInRequired = {status: 401, json: {error: 'Sign in required.'}};
const sameOriginRequired = {status: 403, json: {error: 'Same-origin request required.'}};
const invalidJson = {status: 400, json: {error: 'Invalid JSON body.'}};
const idleScan = {status: 200, json: data => assert.deepEqual([data.status, data.newEvents], ['idle', []])};

for (const [name, vars] of [['without an X secret', {}], ['with a fake local X secret', {X_BEARER_TOKEN: 'fake-local-x-credential'}]]) {
  describe(`built Worker ${name}`, () => {
    let worker;
    before(async () => {
      Object.assign(followUps, {posts: 0, healthy: 0});
      worker = await startBuiltWorker({vars});
    });
    after(async () => {
      if (!worker) return;
      const {survivors, tempRemoved} = await worker.stop();
      assert.deepEqual(survivors, [], 'no Worker process survives the test');
      assert.equal(tempRemoved, true, 'the temporary local D1 state is removed');
    });

    test('early 401 and 403 responses leave the Worker healthy', async () => {
      for (const path of ['/api/portfolio', '/api/monitor', '/api/social']) {
        await postThenHealth(worker, {path, auth: false, body: '{"address":"x","action":"config"}'}, signInRequired);
        await postThenHealth(worker, {path, auth: false, contentType: 'text/plain', body: 'plain text'}, signInRequired);
        await postThenHealth(worker, {path, origin: null, body: '{"address":"x"}'}, sameOriginRequired);
        await postThenHealth(worker, {path, origin: 'https://attacker.example', body: '{"address":"x"}'}, sameOriginRequired);
      }
      assertCleanLog(worker);
    });

    test('the monitor scans as before whatever body it is sent', async () => {
      await postThenHealth(worker, {path: '/api/monitor', body: '{"unused":true}'}, idleScan);
      await postThenHealth(worker, {path: '/api/monitor', contentType: 'text/plain', body: 'not json'}, idleScan);
      assertCleanLog(worker);
    });

    test('malformed portfolio JSON is a 400 and valid JSON is saved', async () => {
      await postThenHealth(worker, {path: '/api/portfolio', body: '{"action":'}, invalidJson);
      await postThenHealth(worker, {path: '/api/portfolio', body: JSON.stringify({action: 'config', config})}, {status: 200, json: {ok: true}});
      assertCleanLog(worker);
    });

    if (vars.X_BEARER_TOKEN) {
      test('social rejects malformed JSON and an invalid address before any provider call', async () => {
        await postThenHealth(worker, {path: '/api/social', body: '{"address":'}, invalidJson);
        await postThenHealth(worker, {path: '/api/social', body: '{"address":"not-a-contract"}'}, {status: 400, json: {error: 'Invalid Solana address.'}});
        assertCleanLog(worker);
      });
    } else {
      test('social without an X secret is a 409', async () => {
        await postThenHealth(worker, {path: '/api/social', body: '{"address":"x"}'}, {status: 409, json: {status: 'not_connected', posts: [], message: 'X API secret is not configured.'}});
        assertCleanLog(worker);
      });
    }

    test('the Worker is still serving and its log never shows the stream error', async () => {
      const health = await send(worker, 'GET', '/api/health', {headers: signedIn});
      assert.equal(health.status, 200);
      assert.equal(worker.alive, true);
      assertCleanLog(worker);
      assert.ok(followUps.posts >= 17, `${followUps.posts} POST requests were sent`);
      assert.equal(followUps.healthy, followUps.posts, 'every POST was followed by a healthy signed-in request');
    });
  });
}
