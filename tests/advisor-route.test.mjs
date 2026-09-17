// GET /api/advisor: market evidence plus a conditional ceiling that stays at zero
// because automated token safety is unverified. DEX Screener is a local fetch double.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {beforeEach, test} from 'node:test';
import {addresses, body, createD1, installFetch, jsonRequest, runtime, signIn, signOut, startClock} from './helpers/harness.mjs';

const {GET} = await import('../app/api/advisor/route.ts');

const TOKEN = addresses.tokenA;
let d1, clock, calls, reply;
const advise = (address = TOKEN) => GET(jsonRequest('/api/advisor?address=' + address));
const pool = (overrides = {}) => ({
  chainId: 'solana', pairAddress: addresses.pairA, baseToken: {address: TOKEN, name: 'Fixture', symbol: 'FIX'},
  priceUsd: '0.5', priceChange: {h1: 10, h24: 0}, liquidity: {usd: 150000}, volume: {h24: 250000},
  txns: {h1: {buys: 30, sells: 10}}, pairCreatedAt: clock.now() - 48 * 3600000, ...overrides,
});
function saveConfig(userId, config) {
  d1.sqlite.prepare('INSERT OR REPLACE INTO research_accounts (user_id, config) VALUES (?, ?)').run(userId, JSON.stringify(config));
}
function recordPosition(userId, amount, closedAt = null) {
  const id = randomUUID();
  d1.sqlite.prepare('INSERT INTO research_positions (id, user_id, data, closed_at) VALUES (?, ?, ?, ?)').run(id, userId, JSON.stringify({id, amount}), closedAt);
}

beforeEach(() => {
  clock = startClock();
  d1 = createD1();
  runtime.env.DB = d1;
  runtime.env.X_BEARER_TOKEN = 'offline-test-credential';
  signIn('user-a');
  saveConfig('user-a', {bankroll: 1000, riskPct: 100, maxAllocationPct: 100});
  reply = () => Response.json([pool()]);
  calls = installFetch(url => reply(url));
});

test('authentication and a valid Solana address are required before any provider call', async () => {
  signOut();
  assert.equal((await advise()).status, 401);
  signIn('user-a');
  for (const address of ['', 'short', '0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl', TOKEN + '/../x']) {
    assert.equal((await advise(encodeURIComponent(address))).status, 400, address);
  }
  assert.equal(calls.length, 0);
});

test('a strong candidate still receives zero allocation because safety is unverified', async () => {
  const response = await advise();
  const data = await body(response);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(new URL(calls[0].url).pathname, '/tokens/v1/solana/' + TOKEN);
  assert.equal(data.coin.verdict, 'Research candidate');
  assert.deepEqual([data.allocation.amount, data.allocation.ceiling, data.allocation.status], [0, 1000, 'Review required']);
  assert.deepEqual([data.safety, data.socialInfluence], ['unverified', 'excluded']);
});

test('the highest-liquidity pool for the exact token is selected', async () => {
  reply = () => Response.json([
    pool({pairAddress: addresses.pairA, liquidity: {usd: 40000}}),
    pool({pairAddress: addresses.pairB, liquidity: {usd: 900000}, chainId: 'ethereum'}),
    pool({pairAddress: addresses.pairC, liquidity: {usd: 800000}, baseToken: {address: addresses.tokenB}}),
    pool({pairAddress: addresses.pairA2, liquidity: {usd: 250000}}),
    pool({pairAddress: addresses.tokenC, liquidity: {}}),
  ]);
  const data = await body(await advise());
  assert.deepEqual([data.coin.pair, data.coin.liquidity], [addresses.pairA2, 250000]);
});

test('missing market evidence produces no coin and zero allocation', async () => {
  for (const pools of [[], [pool({chainId: 'base'})], [pool({baseToken: {address: addresses.tokenB}})]]) {
    clock.advance(3600000); // expire the provider response cache
    reply = () => Response.json(pools);
    const data = await body(await advise());
    assert.deepEqual([data.coin, data.allocation.amount, data.allocation.status], [null, 0, 'No selection']);
  }
});

test('provider failures fail closed with no allocation', async () => {
  for (const failure of [
    () => new Response('rate limited', {status: 429}),
    () => { throw new TypeError('network down'); },
    () => new Response('not json'),
    () => Response.json({pairs: null}),
  ]) {
    clock.advance(3600000);
    reply = failure;
    const response = await advise();
    assert.equal(response.status, 503);
    assert.deepEqual(await body(response), {error: 'Evidence unavailable. No allocation suggested.'});
  }
});

test('open position cost reduces the ceiling; closed and other users’ positions do not', async () => {
  recordPosition('user-a', 300);
  recordPosition('user-a', 200);
  recordPosition('user-a', 400, '2026-01-01T00:00:00.000Z');
  recordPosition('user-b', 900);
  const data = await body(await advise());
  assert.deepEqual([data.allocation.ceiling, data.allocation.amount], [500, 0]);
});

test('storage unavailable fails closed', async () => {
  delete runtime.env.DB;
  assert.equal((await advise()).status, 503);
});

test('cached X evidence and usage have no influence on allocation', async () => {
  const before = await body(await advise());
  d1.sqlite.prepare('INSERT INTO social_cache (address, data, fetched_at) VALUES (?, ?, ?)').run(TOKEN, JSON.stringify({
    address: TOKEN, posts: Array.from({length: 25}, (_, i) => ({text: 'To the moon ' + i, author: 'a' + i})),
    summary: {sampleSize: 25, uniqueAuthors: 25, duplicateText: 0, engagement: 100000}, asOf: new Date().toISOString(),
  }), clock.now());
  d1.queries.length = 0;
  const after = await body(await advise());
  assert.deepEqual([after.coin, after.allocation], [before.coin, before.allocation]);
  assert.equal(d1.queries.some(sql => /social_/.test(sql)), false, 'social tables are never read');
  assert.equal(calls.some(call => new URL(call.url).hostname.endsWith('x.com')), false);
});
