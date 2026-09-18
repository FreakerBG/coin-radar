// Request-body lifecycle for the production POST routes (/api/portfolio, /api/monitor, /api/social).
// Every return path must finalize the request body, rejected and malformed requests must not reach
// storage, locks, X quota or providers, and body cleanup must never change a response.
// These call the route handlers directly; tests/worker/post-body.test.mjs exercises the built Worker.
import assert from 'node:assert/strict';
import {beforeEach, describe, test} from 'node:test';
import {ORIGIN, addresses, body, createD1, failures, installFetch, runtime, signIn, signOut, startClock} from './helpers/harness.mjs';

const portfolio = await import('../app/api/portfolio/route.ts');
const monitor = await import('../app/api/monitor/route.ts');
const social = await import('../app/api/social/route.ts');
const {discardBody, readJsonObject} = await import('../lib/request-body.ts');

const FAKE_CREDENTIAL = 'offline-test-credential';
const routes = {'/api/portfolio': portfolio.POST, '/api/monitor': monitor.POST, '/api/social': social.POST};
const encoder = new TextEncoder();

// A request body whose consumption is observable: how many bytes were pulled, and whether it was
// read to the end or cancelled. `source` is text, 'endless', 'stalled' or an Error to fail with.
function trackedRequest(path, source, {origin = ORIGIN, contentType = 'application/json'} = {}) {
  const state = {pulledBytes: 0, finished: false, cancelled: false};
  let sent = false;
  const stream = new ReadableStream({
    pull(controller) {
      if (source instanceof Error) return controller.error(source);
      if (source === 'stalled') return new Promise(() => {});
      if (source === 'endless') {
        state.pulledBytes += 16384;
        return controller.enqueue(new Uint8Array(16384));
      }
      if (sent) {
        state.finished = true;
        return controller.close();
      }
      sent = true;
      const bytes = encoder.encode(source);
      state.pulledBytes += bytes.byteLength;
      controller.enqueue(bytes);
    },
    cancel() { state.cancelled = true; },
  }, {highWaterMark: 0});
  const headers = new Headers({'content-type': contentType});
  if (origin) headers.set('origin', origin);
  const request = new Request(ORIGIN + path, {method: 'POST', headers, body: stream, duplex: 'half'});
  return {request, state};
}

let d1, calls;
beforeEach(() => {
  startClock();
  d1 = createD1();
  runtime.env.DB = d1;
  runtime.env.X_BEARER_TOKEN = FAKE_CREDENTIAL;
  failures.length = 0;
  calls = installFetch(() => { throw new Error('Unexpected provider call.'); });
  signIn('user-a');
});

// Nothing reached storage (so no lock and no X quota), no provider was called and nothing was reported.
function assertUntouched() {
  assert.deepEqual(d1.queries, [], 'no D1 statement ran');
  assert.deepEqual(calls, [], 'no provider was called');
  assert.deepEqual(failures, [], 'no failure record was written');
}
function assertFinalized({request, state}) {
  assert.equal(request.bodyUsed, true, 'the request body is used after the handler returns');
  assert.ok(state.finished || state.cancelled, 'the body was read to the end or cancelled');
}

describe('early rejections finalize the body without reaching storage', () => {
  for (const [path, POST] of Object.entries(routes)) {
    test(`${path}: signed out is 401`, async () => {
      signOut();
      for (const text of ['{"address":"x","action":"config"}', 'plain text, not JSON']) {
        const tracked = trackedRequest(path, text);
        const response = await POST(tracked.request);
        assert.deepEqual([response.status, await body(response)], [401, {error: 'Sign in required.'}]);
        assertFinalized(tracked);
      }
      assertUntouched();
    });

    test(`${path}: a missing or foreign Origin is 403`, async () => {
      for (const origin of [null, 'https://attacker.test']) {
        const tracked = trackedRequest(path, '{"address":"x"}', {origin});
        const response = await POST(tracked.request);
        assert.deepEqual([response.status, await body(response)], [403, {error: 'Same-origin request required.'}]);
        assertFinalized(tracked);
      }
      assertUntouched();
    });
  }

  test('/api/social: a missing X secret is 409', async () => {
    delete runtime.env.X_BEARER_TOKEN;
    const tracked = trackedRequest('/api/social', JSON.stringify({address: addresses.tokenA}));
    const response = await social.POST(tracked.request);
    assert.deepEqual([response.status, await body(response)], [409, {status: 'not_connected', posts: [], message: 'X API secret is not configured.'}]);
    assertFinalized(tracked);
    assertUntouched();
  });
});

describe('malformed JSON is a client error', () => {
  const malformed = ['{"action":', 'not json', '', 'null', '[]', '"config"'];

  test('/api/portfolio answers 400 without storage or a failure record', async () => {
    for (const text of malformed) {
      const tracked = trackedRequest('/api/portfolio', text);
      const response = await portfolio.POST(tracked.request);
      assert.deepEqual([response.status, await body(response)], [400, {error: 'Invalid JSON body.'}], `body ${JSON.stringify(text)}`);
      assert.equal(tracked.request.bodyUsed, true);
    }
    assertUntouched();
  });

  test('/api/social answers 400 without a lock, X quota, a provider call or a failure record', async () => {
    for (const text of malformed) {
      const tracked = trackedRequest('/api/social', text);
      const response = await social.POST(tracked.request);
      assert.deepEqual([response.status, await body(response)], [400, {error: 'Invalid JSON body.'}], `body ${JSON.stringify(text)}`);
      assert.equal(tracked.request.bodyUsed, true);
    }
    assertUntouched();
  });
});

describe('accepted requests keep their behavior', () => {
  test('/api/monitor discards any body unread, before storage, and scans as before', async () => {
    let finishedAtFirstQuery;
    d1.beforeQuery = () => { finishedAtFirstQuery ??= tracked.state.finished; };
    // Not JSON: the monitor does not interpret a payload, so this is still an ordinary scan.
    const tracked = trackedRequest('/api/monitor', 'not json at all', {contentType: 'text/plain'});
    const response = await monitor.POST(tracked.request);
    const data = await body(response);
    assert.deepEqual([response.status, data.status, data.newEvents], [200, 'idle', []]);
    assert.equal(finishedAtFirstQuery, true, 'the body was finished before the first D1 statement');
    assertFinalized(tracked);
    assert.deepEqual([calls, failures], [[], []]);
  });

  test('/api/portfolio saves valid JSON as before', async () => {
    const config = {bankroll: 1000, riskPct: 2, maxAllocationPct: 5, takeProfitPct: 40, stopPct: 20, trailingPct: 15, liquidityDropPct: 30, xDailyRequests: 5};
    const tracked = trackedRequest('/api/portfolio', JSON.stringify({action: 'config', config}));
    const response = await portfolio.POST(tracked.request);
    assert.deepEqual([response.status, await body(response)], [200, {ok: true}]);
    assert.deepEqual(JSON.parse(d1.rows('SELECT config FROM research_accounts WHERE user_id = ?', 'user-a')[0].config), config);
    assertFinalized(tracked);

    const unknown = trackedRequest('/api/portfolio', '{"action":"nope"}');
    const rejected = await portfolio.POST(unknown.request);
    assert.deepEqual([rejected.status, await body(rejected)], [400, {error: 'Unknown action.'}]);
    const invalid = await portfolio.POST(trackedRequest('/api/portfolio', JSON.stringify({action: 'config', config: {...config, stopPct: 500}})).request);
    assert.deepEqual([invalid.status, await body(invalid)], [400, {error: 'Check the amounts and alert percentages.'}]);
    assert.deepEqual(failures, []);
  });

  test('/api/social rejects an invalid address as before, without storage', async () => {
    const tracked = trackedRequest('/api/social', JSON.stringify({address: 'not-a-contract'}));
    const response = await social.POST(tracked.request);
    assert.deepEqual([response.status, await body(response)], [400, {error: 'Invalid Solana address.'}]);
    assertFinalized(tracked);
    assertUntouched();
  });
});

describe('body cleanup is bounded and cannot change a response', () => {
  test('a body that fails while being discarded leaves every early response unchanged', async () => {
    const cases = [
      ['/api/portfolio', () => signOut(), 401, {error: 'Sign in required.'}],
      ['/api/monitor', () => signIn('user-a'), 403, {error: 'Same-origin request required.'}, null],
      ['/api/social', () => { delete runtime.env.X_BEARER_TOKEN; }, 409, {status: 'not_connected', posts: [], message: 'X API secret is not configured.'}],
    ];
    for (const [path, arrange, status, expected, origin = ORIGIN] of cases) {
      arrange();
      const response = await routes[path](trackedRequest(path, new Error('client reset'), {origin}).request);
      assert.deepEqual([response.status, await body(response)], [status, expected], path);
    }
    // A request whose body cannot even be accessed.
    signOut();
    const hostile = {url: ORIGIN + '/api/portfolio', headers: new Headers({origin: ORIGIN}), bodyUsed: false, get body() { throw new Error('no body'); }};
    const response = await portfolio.POST(hostile);
    assert.deepEqual([response.status, await body(response)], [401, {error: 'Sign in required.'}]);
    assertUntouched();
  });

  test('an endless body is read only up to the limit and then cancelled', async () => {
    signOut();
    const tracked = trackedRequest('/api/portfolio', 'endless');
    const response = await portfolio.POST(tracked.request);
    assert.equal(response.status, 401);
    assert.equal(tracked.state.cancelled, true);
    assert.ok(tracked.state.pulledBytes <= 64 * 1024 + 16384, `pulled ${tracked.state.pulledBytes} bytes`);
  });

  test('a stalled body is cancelled after the timeout instead of holding the response', async () => {
    const tracked = trackedRequest('/api/monitor', 'stalled', {origin: 'https://attacker.test'});
    const started = performance.now();
    const response = await monitor.POST(tracked.request);
    const elapsed = performance.now() - started;
    assert.equal(response.status, 403);
    assert.equal(tracked.state.cancelled, true);
    assert.ok(elapsed >= 900 && elapsed < 5000, `returned after ${Math.round(elapsed)}ms`);
    assertUntouched();
  });

  test('requests without a body, or with a body already used, are left alone', async () => {
    await discardBody(new Request(ORIGIN + '/api/monitor', {method: 'POST'}));
    const used = new Request(ORIGIN + '/api/monitor', {method: 'POST', body: '{}'});
    await used.text();
    await discardBody(used);
    assert.equal(used.bodyUsed, true);
    assert.deepEqual(await readJsonObject(new Request(ORIGIN, {method: 'POST', body: '{"a":1}'})), {a: 1});
  });
});
