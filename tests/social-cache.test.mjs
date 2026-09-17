// X cache isolation: GET/POST /api/social with two users sharing one public cache row.
// Real route, lib/research-db and SQL against SQLite; X is a local fetch double.
import assert from 'node:assert/strict';
import {beforeEach, describe, test} from 'node:test';
import {addresses, body, createD1, installFetch, jsonRequest, runtime, signIn, signOut, startClock} from './helpers/harness.mjs';

const {GET, POST} = await import('../app/api/social/route.ts');

const CONTRACT = addresses.tokenA;
const FAKE_CREDENTIAL = 'offline-test-credential';
const FRESH_MS = 899999, STALE_MS = 900001;
const PUBLIC_KEYS = ['address', 'asOf', 'posts', 'summary'];
const RESPONSE_KEYS = [...PUBLIC_KEYS, 'cached', 'configured', 'dailyLimit', 'message', 'stale', 'status', 'usedToday'].sort();
const users = {'user-a': {limit: 10, used: 4}, 'user-b': {limit: 3, used: 1}};

let d1, clock, xCalls, xReply;
const today = () => new Date().toISOString().slice(0, 10);
const usage = userId => d1.rows('SELECT requests FROM social_usage WHERE id = ?', `x:${userId}:${today()}`)[0]?.requests ?? 0;
const cacheRow = () => d1.rows('SELECT data, fetched_at FROM social_cache WHERE address = ?', CONTRACT)[0];
const locks = () => d1.rows('SELECT id FROM research_locks');
const setLimit = (userId, limit) => d1.sqlite.prepare('INSERT OR REPLACE INTO research_accounts (user_id, config) VALUES (?, ?)').run(userId, JSON.stringify({xDailyRequests: limit}));
const setUsage = (userId, requests) => d1.sqlite.prepare('INSERT OR REPLACE INTO social_usage (id, requests) VALUES (?, ?)').run(`x:${userId}:${today()}`, requests);
const seedCache = (data, ageMs) => d1.sqlite.prepare('INSERT OR REPLACE INTO social_cache (address, data, fetched_at) VALUES (?, ?, ?)').run(CONTRACT, JSON.stringify(data), clock.now() - ageMs);
const get = (address = CONTRACT) => GET(jsonRequest('/api/social?address=' + address));
const post = (address = CONTRACT, origin) => POST(jsonRequest('/api/social', {method: 'POST', body: {address}, origin}));

const publicEvidence = {
  address: CONTRACT,
  posts: [{text: 'Public contract evidence', date: '2026-01-01T00:00:00.000Z', url: 'https://x.com/i/status/1', author: 'public-author'}],
  summary: {sampleSize: 1, uniqueAuthors: 1, duplicateText: 0, engagement: 3, warning: 'Bounded sample.'},
  asOf: '2026-01-01T00:00:00.000Z',
};
// A row written before the fix: it carried the writer's quota, connection state and message.
const legacyRow = {
  ...publicEvidence,
  posts: publicEvidence.posts.map(post => ({...post, requester: 'user-a'})),
  summary: {...publicEvidence.summary, requesterQuota: 10},
  status: 'connected', configured: true, cached: false, stale: false, message: 'LEGACY MESSAGE',
  usedToday: 99, dailyLimit: 99, userId: 'user-a', privateField: 'must not leak',
};
const providerPosts = [
  {id: '101', text: 'Exact contract mention https://t.co/a', author_id: 'author-1', created_at: '2026-01-02T00:00:00.000Z', public_metrics: {like_count: 4, retweet_count: 1}},
  {id: '102', text: 'EXACT contract   mention', author_id: 'author-2', created_at: '2026-01-02T00:01:00.000Z'},
];

beforeEach(() => {
  clock = startClock();
  d1 = createD1();
  runtime.env.DB = d1;
  runtime.env.X_BEARER_TOKEN = FAKE_CREDENTIAL;
  for (const [userId, {limit, used}] of Object.entries(users)) { setLimit(userId, limit); setUsage(userId, used); }
  seedCache(legacyRow, 1000);
  signIn('user-a');
  xReply = () => Response.json({data: providerPosts, meta: {result_count: 2}});
  xCalls = installFetch((url, init) => xReply(url, init));
});

function assertPublicOnly(data) {
  assert.deepEqual(Object.keys(data).sort(), RESPONSE_KEYS);
  assert.deepEqual(data.posts, publicEvidence.posts);
  assert.deepEqual(data.summary, publicEvidence.summary);
  assert.equal(JSON.stringify(data).includes('LEGACY'), false);
  assert.equal(JSON.stringify(data).includes('must not leak'), false);
}

describe('shared cache reads', () => {
  test('two users read the same cached contract, each with their own quota state', async () => {
    for (const read of [get, post]) {
      for (const [userId, {limit, used}] of Object.entries(users)) {
        signIn(userId);
        const response = await read();
        const data = await body(response);
        assert.equal(response.status, 200, `${read.name} ${userId}`);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
        assertPublicOnly(data);
        assert.deepEqual([data.usedToday, data.dailyLimit, data.status, data.configured, data.cached, data.stale], [used, limit, 'connected', true, true, false]);
      }
    }
    assert.equal(xCalls.length, 0, 'fresh cache hits make no X request');
    assert.deepEqual([usage('user-a'), usage('user-b')], [4, 1], 'fresh cache hits reserve no allowance');
    assert.deepEqual(locks(), [], 'lock released after cache hits');
  });

  test('a zero request cap can still read fresh cached evidence', async () => {
    setLimit('user-a', 0);
    seedCache(legacyRow, FRESH_MS);
    const data = await body(await post());
    assert.deepEqual([data.status, data.usedToday, data.dailyLimit], ['connected', 4, 0]);
    assertPublicOnly(data);
    assert.equal(xCalls.length, 0);
  });

  test('GET labels stale evidence without refreshing it', async () => {
    seedCache(legacyRow, STALE_MS);
    const data = await body(await get());
    assert.deepEqual([data.cached, data.stale], [true, true]);
    assertPublicOnly(data);
    assert.equal(xCalls.length, 0);
  });

  test('GET without an address or cache reports only request state', async () => {
    const data = await body(await GET(jsonRequest('/api/social')));
    assert.deepEqual(data.posts, []);
    assert.deepEqual([data.usedToday, data.dailyLimit, data.cached], [4, 10, undefined]);
  });

  test('removing the X credential reports disconnected despite a connected cache row', async () => {
    delete runtime.env.X_BEARER_TOKEN;
    const data = await body(await get());
    assert.deepEqual([data.status, data.configured], ['not_connected', false]);
    assert.match(data.message, /Add X_BEARER_TOKEN/);
    assert.deepEqual(data.posts, publicEvidence.posts, 'already public evidence remains readable');

    seedCache(legacyRow, STALE_MS);
    const response = await post();
    assert.equal(response.status, 409);
    assert.equal((await body(response)).status, 'not_connected');
    assert.equal(xCalls.length, 0);
    assert.equal(usage('user-a'), 4);
  });
});

describe('paid refresh', () => {
  test('stale cache is refreshed once, charged to the caller, and stored as public evidence only', async () => {
    seedCache(legacyRow, STALE_MS);
    signIn('user-b');
    const response = await post();
    const data = await body(response);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual([data.cached, data.stale, data.usedToday, data.dailyLimit], [false, false, 2, 3]);
    assert.equal(xCalls.length, 1);
    const search = new URL(xCalls[0].url);
    assert.equal(search.origin + search.pathname, 'https://api.x.com/2/tweets/search/recent');
    assert.equal(search.searchParams.get('query'), CONTRACT + ' -is:retweet');
    assert.equal(search.searchParams.get('max_results'), '25');

    const row = cacheRow();
    assert.equal(row.fetched_at, clock.now());
    const saved = JSON.parse(row.data);
    assert.deepEqual(Object.keys(saved).sort(), PUBLIC_KEYS);
    assert.deepEqual(saved.posts, [
      {text: providerPosts[0].text, date: providerPosts[0].created_at, url: 'https://x.com/i/status/101', author: 'author-1'},
      {text: providerPosts[1].text, date: providerPosts[1].created_at, url: 'https://x.com/i/status/102', author: 'author-2'},
    ]);
    assert.deepEqual(Object.keys(saved.summary).sort(), ['duplicateText', 'engagement', 'sampleSize', 'uniqueAuthors', 'warning']);
    assert.deepEqual([saved.summary.sampleSize, saved.summary.uniqueAuthors, saved.summary.duplicateText, saved.summary.engagement], [2, 2, 1, 5]);
    assert.equal(row.data.includes(FAKE_CREDENTIAL) || JSON.stringify(data).includes(FAKE_CREDENTIAL), false);
    assert.deepEqual(locks(), []);

    signIn('user-a');
    const shared = await body(await post());
    assert.deepEqual([shared.cached, shared.usedToday, shared.dailyLimit], [true, 4, 10], 'the next user gets the refreshed row with their own quota');
    assert.equal(xCalls.length, 1);
  });

  test('a cache miss triggers a request when allowance remains', async () => {
    d1.sqlite.exec('DELETE FROM social_cache');
    const data = await body(await post());
    assert.deepEqual([data.status, data.cached, data.usedToday], ['connected', false, 5]);
    assert.equal(xCalls.length, 1);
  });

  test('a zero request cap blocks a stale refresh without reserving or calling X', async () => {
    setLimit('user-a', 0);
    seedCache(legacyRow, STALE_MS);
    const response = await post();
    assert.equal(response.status, 429);
    assert.equal((await body(response)).status, 'limit_reached');
    assert.deepEqual([xCalls.length, usage('user-a')], [0, 4]);
    assert.deepEqual(locks(), [], 'lock released after quota rejection');
  });

  test('a reached daily cap blocks a refresh without calling X', async () => {
    setUsage('user-a', 10);
    seedCache(legacyRow, STALE_MS);
    const response = await post();
    assert.equal(response.status, 429);
    assert.match((await body(response)).message, /Daily X request cap reached/);
    assert.deepEqual([xCalls.length, usage('user-a')], [0, 10]);
    assert.deepEqual(locks(), []);
  });

  test('quota reservation is atomic across concurrent refreshes by one user', async () => {
    setLimit('user-a', 5);
    d1.sqlite.exec('DELETE FROM social_cache');
    const results = await Promise.all([post(addresses.tokenA), post(addresses.tokenB), post(addresses.tokenC)]);
    assert.deepEqual(results.map(response => response.status).sort(), [200, 429, 429]);
    assert.deepEqual([xCalls.length, usage('user-a')], [1, 5]);
  });

  test('a provider error still consumes the reserved request and leaves the cache untouched', async () => {
    seedCache(legacyRow, STALE_MS);
    const before = cacheRow();
    xReply = () => new Response('unavailable', {status: 500});
    const response = await post();
    assert.equal(response.status, 502);
    assert.match((await body(response)).message, /counts against the daily request cap/);
    assert.deepEqual([xCalls.length, usage('user-a')], [1, 5]);
    assert.deepEqual(cacheRow(), before);
    assert.deepEqual(locks(), [], 'lock released after provider failure');
  });

  test('a network failure after reservation fails closed and consumes the request', async () => {
    seedCache(legacyRow, STALE_MS);
    xReply = () => { throw new TypeError('network down'); };
    const response = await post();
    assert.equal(response.status, 503);
    assert.deepEqual((await body(response)).posts, []);
    assert.equal(usage('user-a'), 5);
    assert.deepEqual(locks(), []);
  });

  test('malformed provider responses add no evidence', async () => {
    for (const reply of [
      () => Response.json({errors: [{title: 'Invalid Request'}]}),
      () => new Response('<html>not json</html>', {status: 200}),
      () => Response.json({data: [{id: '1', author_id: 'no-text'}]}),
    ]) {
      seedCache(legacyRow, STALE_MS);
      const before = cacheRow();
      xReply = reply;
      const response = await post();
      assert.equal(response.status, 503);
      assert.match((await body(response)).message, /No social evidence was added/);
      assert.deepEqual(cacheRow(), before);
      assert.deepEqual(locks(), []);
    }
    assert.equal(usage('user-a'), 7, 'each attempt consumed allowance');
  });

  test('a refresh already in progress for the contract is not duplicated', async () => {
    seedCache(legacyRow, STALE_MS);
    d1.sqlite.prepare('INSERT INTO research_locks (id, owner, expires) VALUES (?, ?, ?)').run('social:' + CONTRACT, 'other-request', clock.now() + 30000);
    const response = await post();
    assert.equal(response.status, 409);
    assert.equal((await body(response)).status, 'busy');
    assert.deepEqual([xCalls.length, usage('user-a')], [0, 4]);
    assert.deepEqual(locks(), [{id: 'social:' + CONTRACT}], 'another request’s lock is not released');
  });
});

describe('request guards run before storage or provider access', () => {
  test('unauthenticated GET and POST are rejected', async () => {
    signOut();
    assert.equal((await get()).status, 401);
    assert.equal((await post()).status, 401);
    assert.deepEqual([d1.queries.length, xCalls.length], [0, 0]);
  });

  test('cross-origin and origin-less POSTs are rejected', async () => {
    assert.equal((await post(CONTRACT, 'https://attacker.test')).status, 403);
    assert.equal((await post(CONTRACT, null)).status, 403);
    assert.deepEqual([d1.queries.length, xCalls.length], [0, 0]);
  });

  test('invalid contract addresses are rejected', async () => {
    assert.equal((await get('not-a-contract')).status, 400);
    assert.equal((await post('0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl')).status, 400);
    assert.equal(xCalls.length, 0);
  });

  test('storage unavailable fails closed', async () => {
    delete runtime.env.DB;
    const response = await get();
    assert.equal(response.status, 503);
    assert.equal((await body(response)).message, 'Social research storage unavailable.');
    seedCache(legacyRow, STALE_MS);
    assert.equal((await post()).status, 503);
    assert.equal(xCalls.length, 0);
  });
});
