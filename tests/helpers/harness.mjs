// Offline test harness: a D1-compatible database backed by node:sqlite with the
// production migration applied, simulated Sites authentication, a recorded fetch
// double and a controllable clock. Nothing here contacts a network or real account.
import {readFileSync} from 'node:fs';
import {register} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {mock} from 'node:test';

export const runtime = globalThis.coinRadarTest ??= {env: {}, headers: new Headers()};
register(new URL('./loader.mjs', import.meta.url));

export const ORIGIN = 'https://coin-radar.test';
const migration = readFileSync(new URL('../../drizzle/0000_rare_terror.sql', import.meta.url), 'utf8')
  .split('--> statement-breakpoint').join('\n');

// Contract-shaped (base58, 32-44 chars) fixture addresses. Not real tokens.
export const addresses = {
  tokenA: 'TokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  tokenB: 'TokenBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  tokenC: 'TokenCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
  pairA: 'PairAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  pairA2: 'PairAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2',
  pairB: 'PairBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  pairC: 'PairCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
};

const tick = () => new Promise(resolve => setImmediate(resolve));

// D1's prepared-statement surface (prepare/bind/first/all/run) over SQLite.
// Each call yields to the event loop first so concurrent requests interleave
// between statements, as they can against a remote D1 database.
export function createD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(migration);
  const d1 = {
    sqlite,
    queries: [],
    // Optional hook run before each statement; throw from it to simulate a storage failure.
    beforeQuery: null,
    prepare(sql) { return statement(sql, []); },
    rows(sql, ...params) { return sqlite.prepare(sql).all(...params).map(row => ({...row})); },
  };
  function statement(sql, params) {
    const execute = async method => {
      await tick();
      d1.queries.push(sql);
      d1.beforeQuery?.(sql, params);
      return sqlite.prepare(sql)[method](...params);
    };
    return {
      bind: (...values) => statement(sql, values),
      async first() { const row = await execute('get'); return row ? {...row} : null; },
      async all() { const rows = await execute('all'); return {results: rows.map(row => ({...row})), success: true, meta: {}}; },
      async run() { const result = await execute('run'); return {success: true, meta: {changes: Number(result.changes)}}; },
    };
  }
  return d1;
}

export function signIn(userId) {
  runtime.headers = new Headers({
    'oai-authenticated-user-id': userId,
    'oai-authenticated-user-email': userId + '@example.test',
  });
}
export function signOut() { runtime.headers = new Headers(); }

export function jsonRequest(path, {method = 'GET', body, origin = ORIGIN} = {}) {
  const headers = new Headers();
  if (origin) headers.set('origin', origin);
  if (body !== undefined) headers.set('content-type', 'application/json');
  return new Request(ORIGIN + path, {method, headers, body: body === undefined ? undefined : JSON.stringify(body)});
}

// Replace global fetch. Records method and URL only, never request headers.
export function installFetch(handler) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({url, method: init.method || 'GET'});
    await tick();
    return handler(url, init);
  };
  return calls;
}
export const offlineFetch = () => { throw new Error('Unexpected network request in an offline test.'); };

// lib/market.ts keeps a module-level response cache keyed by URL. Each test gets a
// clock far beyond earlier tests' TTLs, so cached provider data never crosses tests.
let clockBase = Date.UTC(2026, 0, 5, 12);
export function startClock() {
  mock.timers.reset();
  clockBase += 7 * 24 * 3600 * 1000;
  mock.timers.enable({apis: ['Date'], now: clockBase});
  return {
    now: () => Date.now(),
    advance: ms => mock.timers.setTime(Date.now() + ms),
  };
}

export async function body(response) { return response.json(); }
