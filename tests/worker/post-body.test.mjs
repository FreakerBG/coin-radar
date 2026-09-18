// Real built-Worker regression for request bodies (`npm run test:worker` builds first).
// Under `wrangler dev`, a response sent while a request body was still unread made the dev proxy log
// an uncaught "Can't read from request stream after response has been sent" (workerd issue #918); the
// next request then got Wrangler's 503 "worker restarted mid-request" or hung on the kept-alive
// connection, and responses could lose their body. This drives the built Worker over HTTP with fake
// local sign-in headers and a temporary local D1: small, empty, large (> 64 KiB), slow chunked and
// abandoned bodies, on the application's POST handlers and on framework-generated 405 responses.
// Every completed request is followed by a signed-in health check on the same connection, and the
// debug log must never show the stream error. No request reaches a provider; the X credential is fake.
import assert from 'node:assert/strict';
import http from 'node:http';
import {after, before, describe, test} from 'node:test';
import {startBuiltWorker} from '../helpers/built-worker.mjs';

const STREAM_ERROR = "Can't read from request stream after response has been sent";
const RESTARTED = 'Your worker restarted mid-request';
const DEBUG_LINE = '[wrangler-ProxyWorker:info] ';
// Each follow-up health check the Worker really served, as its dev proxy logs it.
const HEALTH_SERVED = '[wrangler-ProxyWorker:info] GET /api/health 200';
const WATCH = [STREAM_ERROR, RESTARTED, DEBUG_LINE, HEALTH_SERVED];
const REQUEST_TIMEOUT_MS = 8000;
const signedIn = {'oai-authenticated-user-id': 'local-worker-test', 'oai-authenticated-user-email': 'worker-test@example.test'};
const config = {bankroll: 1000, riskPct: 2, maxAllocationPct: 5, takeProfitPct: 40, stopPct: 20, trailingPct: 15, liquidityDropPct: 30, xDailyRequests: 5};
const large = JSON.stringify({padding: 'x'.repeat(128 * 1024)});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// One HTTP request over `agent`. `body` is sent with Content-Length; `parts` ([delayMs, text] pairs)
// are sent chunked, each after its delay; `disconnect` destroys the socket after the parts instead
// of finishing the body. Every request is bounded: past REQUEST_TIMEOUT_MS it is destroyed and fails.
function request(worker, agent, {method = 'GET', path, headers = {}, body, parts, disconnect = false}) {
  return new Promise((resolve, reject) => {
    const outgoing = {...headers};
    if (body !== undefined) outgoing['content-length'] = Buffer.byteLength(body);
    const req = http.request(worker.origin + path, {method, agent, headers: outgoing});
    const timer = setTimeout(() => req.destroy(new Error(`${method} ${path} got no complete response within ${REQUEST_TIMEOUT_MS}ms`)), REQUEST_TIMEOUT_MS);
    const settle = (fn, value) => { clearTimeout(timer); fn(value); };
    req.on('response', res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => settle(resolve, {status: res.statusCode, text}));
      res.on('error', error => settle(reject, error));
    });
    req.on('error', error => (disconnect ? settle(resolve, {disconnected: true}) : settle(reject, error)));
    (async () => {
      if (body !== undefined) return req.end(body);
      for (const [delay, text] of parts || []) {
        await sleep(delay);
        if (req.destroyed) return;
        req.write(text);
      }
      if (disconnect) req.destroy();
      else req.end();
    })();
  });
}

function parse(text) {
  try { return JSON.parse(text); } catch { return text; }
}

// Sends one request and a signed-in health check over the same kept-alive connection, and checks
// the complete response of both. The counts let the last test confirm every request had a healthy
// follow-up.
const followUps = {requests: 0, healthy: 0};
// Every unsupported method/route pair answered with vinext's 405, so the last test can check coverage.
const answered405 = new Set();
async function exchange(worker, spec, expected) {
  followUps.requests++;
  const agent = new http.Agent({keepAlive: true, maxSockets: 1});
  const before = WATCH.map(text => worker.count(text));
  try {
    const headers = {...(spec.contentType === null ? {} : {'content-type': spec.contentType || 'application/json'}), ...(spec.auth === false ? {} : signedIn)};
    if (spec.origin === undefined) headers.origin = worker.origin;
    else if (spec.origin) headers.origin = spec.origin;
    const label = `${spec.method || 'POST'} ${spec.path}`;
    const response = await request(worker, agent, {method: 'POST', ...spec, headers});
    if (expected === 'disconnected') {
      // The client gave up; whatever the Worker did with the abandoned body must not break it.
    } else {
      assert.equal(response.status, expected.status, `${label}: ${response.text}`);
      if (typeof expected.json === 'function') expected.json(parse(response.text));
      else if ('json' in expected) assert.deepEqual(parse(response.text), expected.json, label);
      else assert.equal(response.text, expected.text, label);
      if (response.status === 405) answered405.add(label);
    }
    await sleep(50);
    const health = await request(worker, agent, {path: '/api/health', headers: signedIn});
    assert.equal(health.status, 200, `follow-up health after ${label}: ${health.text}`);
    const status = parse(health.text);
    assert.deepEqual([status.status, status.storage, status.schema], ['ok', 'ok', 'compatible']);
    assert.equal(worker.alive, true, `the Worker is still running after ${label}`);
    assert.deepEqual([worker.count(STREAM_ERROR) - before[0], worker.count(RESTARTED) - before[1]], [0, 0], `${label} left the uncaught stream error or a restart in the Worker log`);
    if (health.status === 200 && status.status === 'ok' && worker.alive) followUps.healthy++;
  } finally {
    agent.destroy();
  }
}

// The error is printed only at debug level, and in Wrangler's dev proxy; a log without the proxy's
// debug output could not show it.
function assertCleanLog(worker) {
  assert.ok(worker.count(DEBUG_LINE) > 0, 'the Worker log is captured at debug level');
  assert.equal(worker.count(STREAM_ERROR), 0, `the Worker log contains the uncaught stream error ${worker.count(STREAM_ERROR)} times`);
  assert.equal(worker.count(RESTARTED), 0, 'Wrangler reported a restarted Worker');
}
// A stand-in for a Worker whose whole output is `log`, to check assertCleanLog itself.
const loggedWorker = log => ({count: text => log.split(text).length - 1});

test('the log check recognizes the uncaught stream error', () => {
  const debugLine = '[wrangler-ProxyWorker:info] GET /api/health 200 OK (5ms)\n';
  assert.doesNotThrow(() => assertCleanLog(loggedWorker(debugLine)));
  assert.throws(() => assertCleanLog(loggedWorker(debugLine + 'uncaught exception; source = Uncaught (async); stack = TypeError: ' + STREAM_ERROR + '.')), /uncaught stream error/);
  assert.throws(() => assertCleanLog(loggedWorker(debugLine + RESTARTED)), /restarted/);
  assert.throws(() => assertCleanLog(loggedWorker('[wrangler:info] GET /api/health 200 OK (5ms)\n')), /debug level/);
});

const signInRequired = {status: 401, json: {error: 'Sign in required.'}};
const sameOriginRequired = {status: 403, json: {error: 'Same-origin request required.'}};
const secretMissing = {status: 409, json: {status: 'not_connected', posts: [], message: 'X API secret is not configured.'}};
const invalidJson = {status: 400, json: {error: 'Invalid JSON body.'}};
const idleScan = {status: 200, json: data => assert.deepEqual([data.status, data.newEvents], ['idle', []])};
const methodNotAllowed = {status: 405, text: ''};
// A body whose last chunk arrives after the old one-second cutoff.
const slow = (first, rest) => [[0, first], [1500, rest]];
const postRoutes = ['/api/portfolio', '/api/monitor', '/api/social'];
const apiRoutes = {
  '/api/advisor': ['GET'], '/api/health': ['GET'], '/api/market': ['GET'], '/api/monitor': ['POST'],
  '/api/news': ['GET'], '/api/portfolio': ['GET', 'POST'], '/api/social': ['GET', 'POST'],
};

for (const [name, vars] of [['without an X secret', {}], ['with a fake local X secret', {X_BEARER_TOKEN: 'fake-local-x-credential'}]]) {
  const secret = Boolean(vars.X_BEARER_TOKEN);
  describe(`built Worker ${name}`, () => {
    let worker;
    before(async () => {
      Object.assign(followUps, {requests: 0, healthy: 0});
      answered405.clear();
      worker = await startBuiltWorker({vars, watch: WATCH});
    });
    after(async () => {
      if (!worker) return;
      const {survivors, tempRemoved} = await worker.stop();
      assert.deepEqual(survivors, [], 'no Worker process survives the test');
      assert.equal(tempRemoved, true, 'the temporary local D1 state is removed');
    });

    test('small bodies on every 401 and 403 path', async () => {
      for (const path of postRoutes) {
        await exchange(worker, {path, auth: false, body: '{"address":"x","action":"config"}'}, signInRequired);
        await exchange(worker, {path, auth: false, contentType: 'text/plain', body: 'plain text'}, signInRequired);
        await exchange(worker, {path, origin: null, body: '{"address":"x"}'}, sameOriginRequired);
        await exchange(worker, {path, origin: 'https://attacker.example', body: '{"address":"x"}'}, sameOriginRequired);
      }
      assertCleanLog(worker);
    });

    test('POSTs without a body', async () => {
      await exchange(worker, {path: '/api/portfolio', auth: false, contentType: null}, signInRequired);
      await exchange(worker, {path: '/api/monitor', contentType: null}, idleScan);
      await exchange(worker, {path: '/api/portfolio', contentType: null}, invalidJson);
      await exchange(worker, {path: '/api/social', contentType: null}, secret ? invalidJson : secretMissing);
      assertCleanLog(worker);
    });

    test('bodies larger than 64 KiB', async () => {
      await exchange(worker, {path: '/api/portfolio', auth: false, body: large}, signInRequired);
      await exchange(worker, {path: '/api/social', origin: 'https://attacker.example', body: large}, sameOriginRequired);
      await exchange(worker, {path: '/api/monitor', body: large}, idleScan);
      await exchange(worker, {path: '/api/social', body: large}, secret ? {status: 400, json: {error: 'Invalid Solana address.'}} : secretMissing);
      assertCleanLog(worker);
    });

    test('chunked bodies that finish after more than one second', async () => {
      await exchange(worker, {path: '/api/portfolio', auth: false, parts: slow('{"action":', '"config"}')}, signInRequired);
      await exchange(worker, {path: '/api/monitor', origin: 'https://attacker.example', parts: slow('{"a":', '1}')}, sameOriginRequired);
      await exchange(worker, {path: '/api/monitor', parts: slow('not ', 'json')}, idleScan);
      await exchange(worker, {path: '/api/social', parts: slow('{"address":', '"x"}')}, secret ? {status: 400, json: {error: 'Invalid Solana address.'}} : secretMissing);
      await exchange(worker, {path: '/api/portfolio', parts: slow('{"action":', '')}, invalidJson);
      assertCleanLog(worker);
    });

    test('a client that abandons its body mid-stream', async () => {
      await exchange(worker, {path: '/api/portfolio', auth: false, parts: [[0, '{"action":']], disconnect: true}, 'disconnected');
      await exchange(worker, {path: '/api/monitor', parts: [[0, '{"a":'], [300, '1']], disconnect: true}, 'disconnected');
      await exchange(worker, {path: '/api/social', parts: [[0, '{"address":']], disconnect: true}, 'disconnected');
      assertCleanLog(worker);
    });

    test('unsupported methods with a body get the framework 405 on every API route', async () => {
      for (const [path, methods] of Object.entries(apiRoutes)) {
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'].filter(method => !methods.includes(method))) {
          await exchange(worker, {method, path, body: '{"unused":true}'}, methodNotAllowed);
        }
      }
      await exchange(worker, {method: 'POST', path: '/api/health', body: large}, methodNotAllowed);
      await exchange(worker, {method: 'PUT', path: '/api/portfolio', parts: slow('{"a":', '1}')}, methodNotAllowed);
      // A path no route matches: vinext answers 404 itself.
      await exchange(worker, {path: '/api/not-a-route', body: large}, {status: 404, json: () => {}});
      assertCleanLog(worker);
    });

    test('malformed portfolio JSON is a 400 and valid JSON is saved', async () => {
      await exchange(worker, {path: '/api/portfolio', body: '{"action":'}, invalidJson);
      await exchange(worker, {path: '/api/portfolio', body: JSON.stringify({action: 'config', config})}, {status: 200, json: {ok: true}});
      assertCleanLog(worker);
    });

    if (secret) {
      test('social rejects malformed JSON and an invalid address before any provider call', async () => {
        await exchange(worker, {path: '/api/social', body: '{"address":'}, invalidJson);
        await exchange(worker, {path: '/api/social', body: '{"address":"not-a-contract"}'}, {status: 400, json: {error: 'Invalid Solana address.'}});
        assertCleanLog(worker);
      });
    } else {
      test('social without an X secret is a 409', async () => {
        await exchange(worker, {path: '/api/social', body: '{"address":"x"}'}, secretMissing);
        await exchange(worker, {path: '/api/social', parts: slow('{"address":', '"x"}')}, secretMissing);
        assertCleanLog(worker);
      });
    }

    test('the Worker is still serving and its log never shows the stream error', async () => {
      const agent = new http.Agent();
      const health = await request(worker, agent, {path: '/api/health', headers: signedIn}).finally(() => agent.destroy());
      assert.equal(health.status, 200);
      assert.equal(worker.alive, true);
      assertCleanLog(worker);
      assert.ok(followUps.requests >= 60, `${followUps.requests} requests were sent`);
      assert.equal(followUps.healthy, followUps.requests, 'every request was followed by a healthy signed-in request');
      assert.ok(worker.count(HEALTH_SERVED) >= followUps.requests + 1, `the Worker served ${worker.count(HEALTH_SERVED)} health checks for ${followUps.requests} requests`);
      const unsupported = Object.entries(apiRoutes).flatMap(([path, methods]) => ['POST', 'PUT', 'PATCH', 'DELETE'].filter(method => !methods.includes(method)).map(method => `${method} ${path}`));
      assert.equal(unsupported.length, 25);
      assert.deepEqual(unsupported.filter(pair => !answered405.has(pair)), [], 'every unsupported method on every API route was sent a body and answered 405');
    });
  });
}
