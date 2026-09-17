// POST /api/monitor: per-user lock, exact pool matching, observed peaks and durable,
// deduplicated exit-review events. DEX Screener is a local fetch double.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {beforeEach, test} from 'node:test';
import {addresses, body, createD1, installFetch, jsonRequest, runtime, signIn, signOut, startClock} from './helpers/harness.mjs';

const {POST} = await import('../app/api/monitor/route.ts');

let d1, clock, calls, pools;
const scan = origin => POST(jsonRequest('/api/monitor', {method: 'POST', body: {}, origin}));
const locks = () => d1.rows('SELECT id, owner FROM research_locks');
const stored = id => JSON.parse(d1.rows('SELECT data FROM research_positions WHERE id = ?', id)[0].data);
const eventRows = userId => d1.rows('SELECT id, position_id, kind FROM research_events WHERE user_id = ? ORDER BY id', userId);
const pool = (pair, token, priceUsd, liquidity, overrides = {}) => ({chainId: 'solana', pairAddress: pair, baseToken: {address: token}, priceUsd, liquidity: {usd: liquidity}, ...overrides});
function recordPosition(userId, overrides = {}, closedAt = null) {
  const p = {
    id: randomUUID(), address: addresses.tokenA, pair: addresses.pairA, symbol: 'FIX', entryPrice: 1, amount: 100, quantity: 100,
    peakPrice: 1, entryLiquidity: 100000, takeProfitPct: 50, stopPct: 25, trailingPct: 25, liquidityDropPct: 50,
    openedAt: '2026-01-01T00:00:00.000Z', closedAt, lastPrice: null, lastCheckedAt: null, ...overrides,
  };
  d1.sqlite.prepare('INSERT INTO research_positions (id, user_id, data, closed_at) VALUES (?, ?, ?, ?)').run(p.id, userId, JSON.stringify(p), closedAt);
  return p;
}

beforeEach(() => {
  clock = startClock();
  d1 = createD1();
  runtime.env.DB = d1;
  signIn('user-a');
  pools = [pool(addresses.pairA, addresses.tokenA, '1.1', 100000)];
  calls = installFetch(() => typeof pools === 'function' ? pools() : Response.json({pairs: pools}));
});

test('authentication and same-origin are required before locking or provider calls', async () => {
  signOut();
  assert.equal((await scan()).status, 401);
  signIn('user-a');
  assert.equal((await scan('https://attacker.test')).status, 403);
  assert.equal((await scan(null)).status, 403);
  assert.deepEqual([d1.queries.length, calls.length], [0, 0]);
});

test('no open positions is an idle scan without a provider call', async () => {
  recordPosition('user-a', {}, '2026-01-02T00:00:00.000Z');
  recordPosition('user-b');
  const data = await body(await scan());
  assert.deepEqual([data.status, data.newEvents], ['idle', []]);
  assert.deepEqual([calls.length, locks()], [0, []]);
});

test('an unexpired lock held by another scan makes this one busy; other users are unaffected', async () => {
  recordPosition('user-a');
  d1.sqlite.prepare('INSERT INTO research_locks (id, owner, expires) VALUES (?, ?, ?)').run('monitor:user-a', 'other-scan', clock.now() + 30000);
  const data = await body(await scan());
  assert.deepEqual([data.status, data.newEvents, calls.length], ['busy', [], 0]);
  assert.deepEqual(locks(), [{id: 'monitor:user-a', owner: 'other-scan'}], 'the other scan keeps its lock');

  signIn('user-b');
  assert.equal((await body(await scan())).status, 'idle');
});

test('an expired lock is taken over and released after the scan', async () => {
  recordPosition('user-a');
  d1.sqlite.prepare('INSERT INTO research_locks (id, owner, expires) VALUES (?, ?, ?)').run('monitor:user-a', 'crashed-scan', clock.now() - 1);
  assert.equal((await body(await scan())).status, 'checked');
  assert.deepEqual(locks(), []);
});

test('concurrent scans by one user run once', async () => {
  recordPosition('user-a', {}, null);
  pools = [pool(addresses.pairA, addresses.tokenA, '0.5', 100000)];
  const results = await Promise.all([scan(), scan(), scan()].map(async r => body(await r)));
  assert.deepEqual(results.map(r => r.status).sort(), ['busy', 'busy', 'checked']);
  assert.equal(eventRows('user-a').length, 1);
  assert.deepEqual(locks(), []);
});

test('uses the exact recorded pair and token, updates observed peak and last check', async () => {
  const p = recordPosition('user-a');
  const q = recordPosition('user-a', {pair: addresses.pairB, address: addresses.tokenB});
  const r = recordPosition('user-a', {pair: addresses.pairA, address: addresses.tokenC});
  pools = [
    pool(addresses.pairA, addresses.tokenA, '1.25', 100000),
    pool(addresses.pairB, addresses.tokenB, '1.3', 100000, {chainId: 'ethereum'}),
    pool(addresses.pairB, addresses.tokenA, '1.4', 100000),
  ];
  const data = await body(await scan());
  assert.equal(data.status, 'checked');
  assert.equal(data.monitoring, 'browser_open_only');
  assert.equal(new URL(calls[0].url).pathname, `/latest/dex/pairs/solana/${addresses.pairA},${addresses.pairB}`, 'unique recorded pairs only');

  const updated = stored(p.id);
  assert.deepEqual([updated.peakPrice, updated.lastPrice, updated.lastCheckedAt], [1.25, 1.25, new Date(clock.now()).toISOString()]);
  assert.deepEqual(data.newEvents.map(e => [e.positionId, e.kind]).sort(), [[q.id, 'data_unavailable'], [r.id, 'data_unavailable']].sort(),
    'a pool on another chain or for another token is not used');

  pools = [pool(addresses.pairA, addresses.tokenA, '1.1', 100000)];
  clock.advance(11000);
  await scan();
  assert.equal(stored(p.id).peakPrice, 1.25, 'peak is kept when the price falls back');
});

test('each rule creates one durable event per position across repeated scans', async () => {
  const p = recordPosition('user-a');
  pools = [pool(addresses.pairA, addresses.tokenA, '0.75', 100000)];
  const first = await body(await scan());
  assert.deepEqual(first.newEvents.map(e => [e.kind, e.severity, e.positionId, e.price]), [['loss_threshold', 'urgent', p.id, 0.75]]);

  for (let i = 0; i < 3; i++) {
    clock.advance(11000);
    assert.deepEqual((await body(await scan())).newEvents, []);
  }
  pools = [pool(addresses.pairA, addresses.tokenA, '0.7', 50000)];
  clock.advance(11000);
  assert.deepEqual((await body(await scan())).newEvents.map(e => e.kind), ['liquidity_drop'], 'a different rule is still reported');
  clock.advance(11000);
  await scan();
  assert.deepEqual(eventRows('user-a').map(e => e.id), [p.id + ':liquidity_drop', p.id + ':loss_threshold']);
});

test('closed positions are excluded, including one closed during the scan', async () => {
  const closed = recordPosition('user-a', {pair: addresses.pairB, address: addresses.tokenB}, '2026-01-02T00:00:00.000Z');
  const closing = recordPosition('user-a');
  pools = [pool(addresses.pairA, addresses.tokenA, '0.5', 100000), pool(addresses.pairB, addresses.tokenB, '0.5', 100000)];
  d1.beforeQuery = sql => {
    if (sql.startsWith('UPDATE research_positions SET data')) {
      d1.sqlite.prepare('UPDATE research_positions SET closed_at = ? WHERE id = ?').run('2026-01-03T00:00:00.000Z', closing.id);
    }
  };
  const data = await body(await scan());
  assert.equal(calls[0].url.includes(addresses.pairB), false, 'closed position pair is not requested');
  assert.deepEqual([data.newEvents, eventRows('user-a')], [[], []]);
  assert.equal(stored(closed.id).lastCheckedAt, null);
});

test('partial provider results check matched positions and flag the rest', async () => {
  const seen = recordPosition('user-a');
  const missing = recordPosition('user-a', {pair: addresses.pairB, address: addresses.tokenB});
  const data = await body(await scan());
  assert.equal(data.status, 'checked');
  assert.deepEqual(data.newEvents.map(e => [e.positionId, e.kind]), [[missing.id, 'data_unavailable']]);
  assert.equal(stored(seen.id).lastPrice, 1.1);
});

test('a provider outage reports unavailable data and preserves observed peaks', async () => {
  const p = recordPosition('user-a', {peakPrice: 2});
  for (const outage of [() => new Response('down', {status: 503}), () => { throw new TypeError('network down'); }]) {
    clock.advance(11000);
    pools = outage;
    const response = await scan();
    const data = await body(response);
    assert.equal(response.status, 200);
    assert.equal(data.status, 'provider_unavailable');
    assert.deepEqual([stored(p.id).peakPrice, stored(p.id).lastPrice], [2, null]);
  }
  assert.deepEqual(eventRows('user-a').map(e => e.kind), ['data_unavailable']);
  assert.deepEqual(locks(), []);
});

test('a storage failure mid-scan returns an error and still releases the lock', async () => {
  recordPosition('user-a');
  d1.beforeQuery = sql => { if (sql.startsWith('UPDATE research_positions')) throw new Error('D1 write failed'); };
  const response = await scan();
  assert.equal(response.status, 503);
  assert.match((await body(response)).error, /Position monitoring failed/);
  assert.deepEqual(locks(), []);
});

test('a scan never reads, updates or reports another user’s positions or events', async () => {
  const mine = recordPosition('user-a');
  const theirs = recordPosition('user-b', {pair: addresses.pairB, address: addresses.tokenB});
  const sharedPool = recordPosition('user-b');
  pools = [pool(addresses.pairA, addresses.tokenA, '0.5', 100000), pool(addresses.pairB, addresses.tokenB, '0.5', 100000)];
  const data = await body(await scan());
  assert.equal(calls[0].url.includes(addresses.pairB), false);
  assert.deepEqual(data.newEvents.map(e => e.positionId), [mine.id]);
  assert.deepEqual([eventRows('user-b'), stored(theirs.id).lastCheckedAt, stored(sharedPool.id).lastCheckedAt], [[], null, null]);
  assert.deepEqual(eventRows('user-a').map(e => e.position_id), [mine.id]);
});
