// Offline test harness: a D1-compatible database backed by node:sqlite with every
// production migration applied, simulated Sites authentication, a recorded fetch
// double and a controllable clock. Nothing here contacts a network or real account.
import {register} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {mock} from 'node:test';
import {readMigrations} from '../../scripts/migrations.mjs';
import {applyMigrations} from './migration-db.mjs';

export const runtime = globalThis.coinRadarTest ??= {env: {}, headers: new Headers()};
register(new URL('./loader.mjs', import.meta.url));

export const ORIGIN = 'https://coin-radar.test';
// Every migration listed in drizzle/meta/_journal.json, in order; read once per test process.
const migrations = readMigrations();

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

function migratedMemoryDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  applyMigrations(sqlite, migrations);
  return sqlite;
}

// D1's prepared-statement surface (prepare/bind/first/all/run) over SQLite: a fresh
// in-memory migrated database by default, or a given one (for example an upgraded file).
// Each call yields to the event loop first so concurrent requests interleave
// between statements, as they can against a remote D1 database.
export function createD1(sqlite = migratedMemoryDatabase()) {
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

// Failure records written by lib/diagnostics.ts are collected here instead of printed, so tests can
// assert on them. Any other console output passes through unchanged.
export const failures = [];
for (const level of ['error', 'warn']) {
  const write = console[level].bind(console);
  console[level] = (...args) => {
    try {
      const record = args.length === 1 && typeof args[0] === 'string' ? JSON.parse(args[0]) : null;
      if (record?.event === 'coin_radar.failure') return void failures.push(record);
    } catch {
      // Not a failure record.
    }
    write(...args);
  };
}

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
