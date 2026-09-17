// GET/POST /api/portfolio: per-user configuration and manually recorded positions.
// Recording is bookkeeping only; it is independent of the Advisor and executes nothing.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {beforeEach, describe, test} from 'node:test';
import {addresses, body, createD1, installFetch, jsonRequest, offlineFetch, runtime, signIn, signOut, startClock} from './helpers/harness.mjs';

const {GET, POST} = await import('../app/api/portfolio/route.ts');

let d1;
const validConfig = {bankroll: 1000, riskPct: 2, maxAllocationPct: 5, takeProfitPct: 40, stopPct: 20, trailingPct: 15, liquidityDropPct: 30, xDailyRequests: 5};
const position = (overrides = {}) => ({
  id: randomUUID(), address: addresses.tokenA, pair: addresses.pairA, symbol: 'FIX', entryPrice: 0.5, amount: 250, entryLiquidity: 120000, ...overrides,
});
const send = (payload, origin) => POST(jsonRequest('/api/portfolio', {method: 'POST', body: payload, origin}));
const load = async () => body(await GET());
const storedPositions = userId => d1.rows('SELECT id, user_id, data, closed_at FROM research_positions WHERE user_id = ? ORDER BY id', userId)
  .map(row => ({...row, data: JSON.parse(row.data)}));
const openCount = userId => d1.rows('SELECT COUNT(*) AS n FROM research_positions WHERE user_id = ? AND closed_at IS NULL', userId)[0].n;
function seedOpenPositions(userId, count, closedAt = null) {
  const insert = d1.sqlite.prepare('INSERT INTO research_positions (id, user_id, data, closed_at) VALUES (?, ?, ?, ?)');
  for (let i = 0; i < count; i++) {
    const id = randomUUID();
    insert.run(id, userId, JSON.stringify({...position({id}), quantity: 500, peakPrice: 0.5}), closedAt);
  }
}

beforeEach(() => {
  startClock();
  d1 = createD1();
  runtime.env.DB = d1;
  installFetch(offlineFetch);
  signIn('user-a');
});

describe('guards', () => {
  test('unauthenticated reads and writes are rejected before storage', async () => {
    signOut();
    assert.equal((await GET()).status, 401);
    assert.equal((await send({action: 'config', config: validConfig})).status, 401);
    assert.equal(d1.queries.length, 0);
  });

  test('cross-origin and origin-less writes are rejected before storage', async () => {
    assert.equal((await send({action: 'config', config: validConfig}, 'https://attacker.test')).status, 403);
    assert.equal((await send({action: 'position', position: position()}, null)).status, 403);
    assert.equal(d1.queries.length, 0);
  });

  test('unknown actions and unavailable storage are reported without changes', async () => {
    assert.equal((await send({action: 'buy'})).status, 400);
    delete runtime.env.DB;
    const response = await GET();
    assert.equal(response.status, 503);
    assert.match((await body(response)).error, /saved positions have not been changed/);
    assert.equal((await send({action: 'config', config: validConfig})).status, 503);
  });
});

describe('configuration', () => {
  test('a new account loads default settings with zero budget and zero X requests', async () => {
    const data = await load();
    assert.equal(data.config.bankroll, 0);
    assert.equal(data.config.xDailyRequests, 0);
    assert.deepEqual([data.positions, data.events, data.monitoring], [[], [], 'browser_open_only']);
  });

  test('valid configuration is stored for the authenticated user only', async () => {
    const response = await send({action: 'config', config: validConfig});
    assert.deepEqual([response.status, await body(response)], [200, {ok: true}]);
    assert.deepEqual((await load()).config, validConfig);
    signIn('user-b');
    assert.equal((await load()).config.bankroll, 0, 'another user sees their own defaults');
    await send({action: 'config', config: {...validConfig, bankroll: 5}});
    signIn('user-a');
    assert.equal((await load()).config.bankroll, 1000, 'another user cannot overwrite it');
  });

  test('invalid configuration is rejected and nothing is stored', async () => {
    for (const config of [
      {...validConfig, bankroll: -1}, {...validConfig, bankroll: 1e8 + 1}, {...validConfig, riskPct: 0},
      {...validConfig, maxAllocationPct: 100.1}, {...validConfig, stopPct: 99.5}, {...validConfig, trailingPct: 0.5},
      {...validConfig, liquidityDropPct: 100}, {...validConfig, takeProfitPct: 0}, {...validConfig, xDailyRequests: 1.5},
      {...validConfig, xDailyRequests: 101}, {...validConfig, bankroll: '1000'}, {...validConfig, riskPct: undefined}, null,
    ]) {
      const response = await send({action: 'config', config});
      assert.equal(response.status, 400, JSON.stringify(config));
      assert.equal((await body(response)).error, 'Check the amounts and alert percentages.');
    }
    assert.equal(d1.rows('SELECT COUNT(*) AS n FROM research_accounts')[0].n, 0);
  });
});

describe('recording positions', () => {
  test('records quantity from amount and entry price, with thresholds copied from saved settings', async () => {
    await send({action: 'config', config: validConfig});
    const input = position();
    assert.deepEqual(await body(await send({action: 'position', position: input})), {ok: true});

    await send({action: 'config', config: {...validConfig, takeProfitPct: 300, stopPct: 50, trailingPct: 40, liquidityDropPct: 60}});
    const later = position();
    await send({action: 'position', position: later});

    const [stored] = (await load()).positions.filter(p => p.id === input.id);
    assert.equal(stored.quantity, 500);
    assert.deepEqual([stored.peakPrice, stored.closedAt, stored.lastPrice], [0.5, null, null]);
    assert.deepEqual([stored.takeProfitPct, stored.stopPct, stored.trailingPct, stored.liquidityDropPct], [40, 20, 15, 30], 'unchanged by later edits');
    const [newer] = (await load()).positions.filter(p => p.id === later.id);
    assert.deepEqual([newer.takeProfitPct, newer.stopPct, newer.trailingPct, newer.liquidityDropPct], [300, 50, 40, 60]);
  });

  test('invalid position input is rejected', async () => {
    for (const overrides of [
      {id: 'not-a-uuid'}, {address: 'bad'}, {pair: '0OIl'}, {symbol: ''}, {entryPrice: 0}, {entryPrice: -1},
      {amount: 0.001}, {amount: 1e8 + 1}, {entryLiquidity: -5}, {entryLiquidity: undefined},
    ]) {
      assert.equal((await send({action: 'position', position: position(overrides)})).status, 400, JSON.stringify(overrides));
    }
    assert.equal(openCount('user-a'), 0);
  });

  test('recording does not depend on an Advisor recommendation or a configured budget', async () => {
    assert.deepEqual(await body(await send({action: 'position', position: position()})), {ok: true});
    assert.equal(openCount('user-a'), 1);
  });

  test('retrying the same position ID is idempotent and keeps the first record', async () => {
    const input = position();
    await send({action: 'position', position: input});
    const retry = await send({action: 'position', position: {...input, amount: 999}});
    assert.deepEqual([retry.status, await body(retry)], [200, {ok: true}]);
    const rows = storedPositions('user-a');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].data.amount, 250);
  });

  test('a maximum of 30 open positions; closed positions do not count', async () => {
    seedOpenPositions('user-a', 30);
    const response = await send({action: 'position', position: position()});
    assert.equal(response.status, 400);
    assert.equal((await body(response)).error, 'Maximum 30 open positions.');
    assert.equal(openCount('user-a'), 30);

    signIn('user-b');
    seedOpenPositions('user-b', 29);
    seedOpenPositions('user-b', 5, '2026-01-01T00:00:00.000Z');
    assert.deepEqual(await body(await send({action: 'position', position: position()})), {ok: true});
    assert.equal(openCount('user-b'), 30);
  });

  test('retrying a recorded position at the 30-position limit still confirms it', async () => {
    // Regression: the limit was checked before the idempotent insert, so a retry after a lost
    // response for the 30th position reported "Maximum 30 open positions" although it was saved.
    seedOpenPositions('user-a', 29);
    const input = position();
    assert.deepEqual(await body(await send({action: 'position', position: input})), {ok: true});
    const retry = await send({action: 'position', position: input});
    assert.deepEqual([retry.status, await body(retry)], [200, {ok: true}]);
    assert.equal(openCount('user-a'), 30);
  });

  test('concurrent recordings cannot exceed the 30-position limit', async () => {
    seedOpenPositions('user-a', 28);
    const responses = await Promise.all([1, 2, 3, 4].map(() => send({action: 'position', position: position()})));
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 200, 400, 400]);
    assert.equal(openCount('user-a'), 30);
  });

  test('a position ID already used by another account is not reported as recorded', async () => {
    const input = position();
    await send({action: 'position', position: input});
    signIn('user-b');
    const response = await send({action: 'position', position: {...input, amount: 1}});
    assert.equal(response.status, 409);
    assert.equal(JSON.stringify(await body(response)).includes('user-a'), false);
    assert.deepEqual(storedPositions('user-b'), []);
    assert.equal(storedPositions('user-a')[0].data.amount, 250, 'the other account’s record is untouched');
  });
});

describe('account isolation and closing', () => {
  test('users cannot load, close or observe another user’s positions and events', async () => {
    const mine = position();
    await send({action: 'position', position: mine});
    d1.sqlite.prepare('INSERT INTO research_events (id, user_id, position_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(mine.id + ':profit_target', 'user-a', mine.id, 'profit_target', JSON.stringify({kind: 'profit_target', positionId: mine.id}), '2026-01-01T00:00:00.000Z');

    signIn('user-b');
    const theirs = await load();
    assert.deepEqual([theirs.positions, theirs.events], [[], []]);
    const close = await send({action: 'close', id: mine.id});
    assert.deepEqual([close.status, await body(close)], [200, {ok: false}]);

    signIn('user-a');
    const own = await load();
    assert.deepEqual([own.positions.map(p => p.id), own.events.length], [[mine.id], 1]);
  });

  test('closing removes the position from open positions; closing again reports no change', async () => {
    const input = position();
    await send({action: 'position', position: input});
    assert.deepEqual(await body(await send({action: 'close', id: input.id})), {ok: true});
    assert.deepEqual((await load()).positions, []);
    assert.ok(storedPositions('user-a')[0].closed_at, 'history is kept with a close time');
    assert.deepEqual(await body(await send({action: 'close', id: input.id})), {ok: false});
    assert.equal((await send({action: 'close', id: 'not-a-uuid'})).status, 400);
  });
});
