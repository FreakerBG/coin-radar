// Request-body lifecycle. The Worker entry (worker/entry.ts, lib/request-body.ts) reads every request
// body to the end before the response is returned, whatever the route or framework did with it, and
// without buffering it or cutting it off. The production POST routes (/api/portfolio, /api/monitor,
// /api/social) answer 401, 403 and 409 without reading the body, never let rejected or malformed
// requests reach storage, locks, X quota or providers, and answer malformed JSON with 400.
// These run the modules directly; tests/worker/post-body.test.mjs exercises the built Worker.
import assert from 'node:assert/strict';
import {beforeEach, describe, test} from 'node:test';
import {ORIGIN, addresses, body, createD1, failures, installFetch, runtime, signIn, signOut, startClock} from './helpers/harness.mjs';

const portfolio = await import('../app/api/portfolio/route.ts');
const monitor = await import('../app/api/monitor/route.ts');
const social = await import('../app/api/social/route.ts');
const {withFinishedBody, readJsonObject} = await import('../lib/request-body.ts');
const entry = (await import('../worker/entry.ts')).default;

const FAKE_CREDENTIAL = 'offline-test-credential';
const routes = {'/api/portfolio': portfolio.POST, '/api/monitor': monitor.POST, '/api/social': social.POST};
const encoder = new TextEncoder();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A request body whose consumption is observable. `chunks` are sent in order, each after its delay
// in ms; `fail` errors the body after them instead of ending it (a client that disconnects).
function tracked(path, chunks, {origin = ORIGIN, contentType = 'application/json', fail = null, method = 'POST'} = {}) {
  const state = {pulledBytes: 0, finished: false, cancelled: false, errored: false};
  let next = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      if (next < chunks.length) {
        const [delay, text] = Array.isArray(chunks[next]) ? chunks[next] : [0, chunks[next]];
        next++;
        if (delay) await sleep(delay);
        const bytes = typeof text === 'string' ? encoder.encode(text) : text;
        state.pulledBytes += bytes.byteLength;
        return controller.enqueue(bytes);
      }
      if (fail) {
        state.errored = true;
        return controller.error(fail);
      }
      state.finished = true;
      controller.close();
    },
    cancel() { state.cancelled = true; },
  }, {highWaterMark: 0});
  const headers = new Headers({'content-type': contentType});
  if (origin) headers.set('origin', origin);
  const request = new Request(ORIGIN + path, {method, headers, body: stream, duplex: 'half'});
  return {request, state};
}
const megabyte = Array.from({length: 64}, () => new Uint8Array(16384));

let d1, calls;
beforeEach(() => {
  startClock();
  d1 = createD1();
  runtime.env.DB = d1;
  runtime.env.X_BEARER_TOKEN = FAKE_CREDENTIAL;
  failures.length = 0;
  calls = installFetch(() => { throw new Error('Unexpected provider call.'); });
  runtime.vinextFetch = null;
  signIn('user-a');
});

// Nothing reached storage (so no lock and no X quota), no provider was called and nothing was reported.
function assertUntouched() {
  assert.deepEqual(d1.queries, [], 'no D1 statement ran');
  assert.deepEqual(calls, [], 'no provider was called');
  assert.deepEqual(failures, [], 'no failure record was written');
}

describe('routes answer early rejections without reading the body or reaching storage', () => {
  for (const [path, POST] of Object.entries(routes)) {
    test(`${path}: signed out is 401`, async () => {
      signOut();
      for (const text of ['{"address":"x","action":"config"}', 'plain text, not JSON']) {
        const {request, state} = tracked(path, [text]);
        const response = await POST(request);
        assert.deepEqual([response.status, await body(response)], [401, {error: 'Sign in required.'}]);
        assert.deepEqual([request.bodyUsed, state.pulledBytes], [false, 0], 'the body is not read before authentication');
      }
      assertUntouched();
    });

    test(`${path}: a missing or foreign Origin is 403`, async () => {
      for (const origin of [null, 'https://attacker.test']) {
        const {request, state} = tracked(path, ['{"address":"x"}'], {origin});
        const response = await POST(request);
        assert.deepEqual([response.status, await body(response)], [403, {error: 'Same-origin request required.'}]);
        assert.deepEqual([request.bodyUsed, state.pulledBytes], [false, 0], 'the body is not read before the origin check');
      }
      assertUntouched();
    });
  }

  test('/api/social: a missing X secret is 409', async () => {
    delete runtime.env.X_BEARER_TOKEN;
    const {request} = tracked('/api/social', [JSON.stringify({address: addresses.tokenA})]);
    const response = await social.POST(request);
    assert.deepEqual([response.status, await body(response)], [409, {status: 'not_connected', posts: [], message: 'X API secret is not configured.'}]);
    assert.equal(request.bodyUsed, false);
    assertUntouched();
  });
});

describe('malformed JSON is a client error', () => {
  const malformed = ['{"action":', 'not json', '', 'null', '[]', '"config"'];

  test('/api/portfolio answers 400 without storage or a failure record', async () => {
    for (const text of malformed) {
      const response = await portfolio.POST(tracked('/api/portfolio', [text]).request);
      assert.deepEqual([response.status, await body(response)], [400, {error: 'Invalid JSON body.'}], `body ${JSON.stringify(text)}`);
    }
    assertUntouched();
  });

  test('/api/social answers 400 without a lock, X quota, a provider call or a failure record', async () => {
    for (const text of malformed) {
      const response = await social.POST(tracked('/api/social', [text]).request);
      assert.deepEqual([response.status, await body(response)], [400, {error: 'Invalid JSON body.'}], `body ${JSON.stringify(text)}`);
    }
    assertUntouched();
  });

  test('a body that fails while it is read is a 400, not a storage failure', async () => {
    const response = await portfolio.POST(tracked('/api/portfolio', ['{"action":'], {fail: new Error('client reset')}).request);
    assert.deepEqual([response.status, await body(response)], [400, {error: 'Invalid JSON body.'}]);
    assertUntouched();
  });
});

describe('accepted requests keep their behavior', () => {
  test('/api/monitor never reads its body and scans as before', async () => {
    const {request, state} = tracked('/api/monitor', ['not json at all'], {contentType: 'text/plain'});
    const response = await monitor.POST(request);
    const data = await body(response);
    assert.deepEqual([response.status, data.status, data.newEvents], [200, 'idle', []]);
    assert.deepEqual([request.bodyUsed, state.pulledBytes], [false, 0], 'the monitor does not interpret a payload');
    assert.deepEqual([calls, failures], [[], []]);
  });

  test('/api/portfolio saves valid JSON as before', async () => {
    const config = {bankroll: 1000, riskPct: 2, maxAllocationPct: 5, takeProfitPct: 40, stopPct: 20, trailingPct: 15, liquidityDropPct: 30, xDailyRequests: 5};
    const response = await portfolio.POST(tracked('/api/portfolio', [JSON.stringify({action: 'config', config})]).request);
    assert.deepEqual([response.status, await body(response)], [200, {ok: true}]);
    assert.deepEqual(JSON.parse(d1.rows('SELECT config FROM research_accounts WHERE user_id = ?', 'user-a')[0].config), config);
    const unknown = await portfolio.POST(tracked('/api/portfolio', ['{"action":"nope"}']).request);
    assert.deepEqual([unknown.status, await body(unknown)], [400, {error: 'Unknown action.'}]);
    const invalid = await portfolio.POST(tracked('/api/portfolio', [JSON.stringify({action: 'config', config: {...config, stopPct: 500}})]).request);
    assert.deepEqual([invalid.status, await body(invalid)], [400, {error: 'Check the amounts and alert percentages.'}]);
    assert.deepEqual(failures, []);
  });

  test('/api/social rejects an invalid address as before, without storage', async () => {
    const response = await social.POST(tracked('/api/social', [JSON.stringify({address: 'not-a-contract'})]).request);
    assert.deepEqual([response.status, await body(response)], [400, {error: 'Invalid Solana address.'}]);
    assertUntouched();
  });
});

describe('the request body is always finished before the response is returned', () => {
  test('an unread body is read to the end, however large, before the response', async () => {
    const {request, state} = tracked('/api/portfolio', megabyte);
    let pulledWhenHandled;
    const response = await withFinishedBody(request, async forwarded => {
      await sleep(10);
      pulledWhenHandled = state.pulledBytes;
      assert.notEqual(forwarded, request);
      return new Response('early', {status: 401});
    });
    assert.equal(pulledWhenHandled, 0, 'nothing is read ahead while the handler runs');
    assert.deepEqual([state.finished, state.cancelled, state.pulledBytes], [true, false, 64 * 16384]);
    assert.deepEqual([response.status, await response.text()], [401, 'early']);
  });

  test('a slow body delays the response until it ends; it is not cut off', async () => {
    const {request, state} = tracked('/api/monitor', [[0, '{"a":'], [1200, '1}']]);
    const started = performance.now();
    const response = await withFinishedBody(request, async () => new Response('ok'));
    assert.ok(performance.now() - started >= 1100, 'the response waited for the body');
    assert.deepEqual([state.finished, state.cancelled], [true, false]);
    assert.equal(await response.text(), 'ok');
  });

  test('cancelling the forwarded body, as vinext does, leaves the original to be read to the end', async () => {
    const {request, state} = tracked('/api/health', ['{"unused":', 'true}']);
    const response = await withFinishedBody(request, async forwarded => {
      await forwarded.body.cancel();
      return new Response(null, {status: 405});
    });
    assert.equal(response.status, 405);
    assert.deepEqual([state.finished, state.cancelled], [true, false]);
  });

  test('a body the handler reads is passed through intact and finished once', async () => {
    const {request, state} = tracked('/api/portfolio', ['{"action":', '"config"}']);
    const response = await withFinishedBody(request, async forwarded => Response.json(await forwarded.json()));
    assert.deepEqual(await body(response), {action: 'config'});
    assert.deepEqual([state.finished, state.cancelled], [true, false]);
  });

  test('a body that fails, or a handler that throws, never changes the outcome', async () => {
    const failing = tracked('/api/portfolio', ['{"a":'], {fail: new Error('client disconnected')});
    const response = await withFinishedBody(failing.request, async () => Response.json({error: 'Sign in required.'}, {status: 401}));
    assert.deepEqual([response.status, await body(response)], [401, {error: 'Sign in required.'}]);
    assert.equal(failing.state.errored, true);

    const thrown = tracked('/api/portfolio', ['{"a":1}']);
    await assert.rejects(withFinishedBody(thrown.request, async () => { throw new Error('handler failed'); }), /handler failed/);
    assert.equal(thrown.state.finished, true, 'the body is finished even when the handler throws');
  });

  test('a request without a body is passed through unchanged', async () => {
    const request = new Request(ORIGIN + '/api/monitor', {method: 'POST'});
    let received;
    await withFinishedBody(request, async forwarded => { received = forwarded; return new Response('ok'); });
    assert.equal(received, request);
  });

  test('the Worker entry finishes the body around every vinext response, including its own 405', async () => {
    const seen = [];
    runtime.vinextFetch = async (forwarded, env, ctx) => {
      seen.push([forwarded.method, new URL(forwarded.url).pathname, env, ctx]);
      forwarded.body?.cancel();
      return new Response(null, {status: 405});
    };
    const {request, state} = tracked('/api/health', megabyte, {method: 'PUT'});
    const response = await entry.fetch(request, 'env', 'ctx');
    assert.equal(response.status, 405);
    assert.deepEqual(seen, [['PUT', '/api/health', 'env', 'ctx']]);
    assert.deepEqual([state.finished, state.cancelled, state.pulledBytes], [true, false, 64 * 16384]);
  });

  test('readJsonObject accepts only JSON objects', async () => {
    const read = text => readJsonObject(new Request(ORIGIN, {method: 'POST', body: text}));
    assert.deepEqual(await read('{"a":1}'), {a: 1});
    for (const text of ['{"a":', 'null', '[]', '1', '"x"', '']) assert.equal(await read(text), null, text);
  });
});
