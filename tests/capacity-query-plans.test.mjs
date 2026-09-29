// Capacity guard for a 96-invocation/day detector (docs/capacity-96-per-day.md). Turso bills rows read, and a
// full-table scan costs one read per stored row, so a per-detection statement that scanned goldmine_signals or
// goldmine_outcomes would make every one of 96 daily invocations cost more as history grows. This runs a real
// detection-only POST and a real daily GET against a populated database, captures every statement they issue,
// and checks SQLite's query plan for each. The detection path must use only primary-key/index lookups on the
// history tables. The daily GET's settlement may range-scan the pending-outcome index, but never a whole
// table. The dashboard/backtest aggregates that do scan all history are listed exactly, so a new full scan
// anywhere in the scheduled paths fails here instead of surfacing as a Turso quota surprise.
import assert from 'node:assert/strict';
import {beforeEach, describe, test} from 'node:test';
import {addresses, createD1, installFetch, runtime, startClock} from './helpers/harness.mjs';
import {pair} from './helpers/goldmine-fixtures.mjs';

const {GET, POST} = await import('../app/api/goldmine/scheduled/route.ts');
const {MODEL_VERSION} = await import('../lib/goldmine/score.ts');

const HISTORY_TABLES = ['goldmine_signals', 'goldmine_outcomes'];
let d1, clock;

// SQLite reports reading every row of a table as "SCAN <table-or-alias>" (with or without "USING [COVERING]
// INDEX", which only changes the order); an index or primary-key lookup is "SEARCH <table> USING ...". A
// statement with a LIMIT that walks an index in order stops after LIMIT rows, so its SCAN is bounded and is
// not counted. Aliases (`goldmine_outcomes o`) are resolved from the statement text.
function historyScans(sql) {
  const names = new Set(HISTORY_TABLES);
  for (const [, , alias] of sql.matchAll(/\b(goldmine_signals|goldmine_outcomes)\s+(?:AS\s+)?([a-z]\w*)\b/gi)) {
    if (!/^(WHERE|JOIN|ON|ORDER|GROUP|LIMIT|SET|SELECT|USING)$/i.test(alias)) names.add(alias);
  }
  if (/\bLIMIT\s+(\?|\d+)/i.test(sql)) return [];
  const plan = d1.sqlite.prepare('EXPLAIN QUERY PLAN ' + sql).all().map(row => row.detail);
  return plan.filter(detail => {
    const match = /^SCAN (\w+)/.exec(detail);
    return match !== null && names.has(match[1]);
  });
}

function seedHistory(count) {
  const insertSignal = d1.sqlite.prepare('INSERT INTO goldmine_signals (id, address, pair, symbol, model_version, state, score, opportunity, detected_at, detected_price, snapshot, assessment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertOutcome = d1.sqlite.prepare('INSERT INTO goldmine_outcomes (signal_id, horizon, due_at, deadline_at, status) VALUES (?, ?, ?, ?, ?)');
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const id = `hist-${i}`, detected = now - 10 * 24 * 3600000 + i * 60000;
    insertSignal.run(id, `Addr${i}`, `Pair${i}`, 'H', MODEL_VERSION, 'REJECTED', 10, 0, detected, 1, '{}', '{}');
    for (const [horizon, days] of [['d1', 1], ['d3', 3], ['d7', 7]]) insertOutcome.run(id, horizon, detected + days * 86400000, detected + days * 86400000 + 26 * 3600000, i % 2 ? 'observed' : 'pending');
  }
  d1.sqlite.exec('ANALYZE');
}

beforeEach(() => {
  clock = startClock();
  d1 = createD1();
  runtime.env.DB = d1;
  process.env.GOLDMINE_CRON_SECRET = 'header-secret';
  process.env.CRON_SECRET = 'bearer-secret';
  installFetch(url => {
    if (url.startsWith('https://api.dexscreener.com/token-profiles/')) return Response.json([{chainId: 'solana', tokenAddress: addresses.tokenA}]);
    if (url.startsWith('https://api.dexscreener.com/token-boosts/')) return Response.json([]);
    if (url.startsWith('https://api.dexscreener.com/tokens/v1/solana/')) return Response.json([pair({pairCreatedAt: Date.now() - 48 * 3600000})]);
    if (url.startsWith('https://api.dexscreener.com/latest/dex/pairs/solana/')) return Response.json({pairs: []});
    if (url.startsWith('https://api.rugcheck.xyz/v1/tokens/')) return new Response('rate limited', {status: 429});
    throw new Error('Unexpected request ' + url);
  });
  seedHistory(3000);
  d1.queries.length = 0;
});

describe('per-invocation SQL never scans stored history', () => {
  test('a detection-only POST (the 96/day path) uses only key/index lookups on goldmine_signals and goldmine_outcomes', async () => {
    const response = await POST(new Request('https://coin-radar.test/api/goldmine/scheduled', {method: 'POST', headers: {'x-goldmine-cron-secret': 'header-secret'}}));
    assert.equal(response.status, 200);
    const statements = [...new Set(d1.queries)];
    assert.ok(statements.some(sql => sql.startsWith('INSERT OR IGNORE INTO goldmine_signals')), 'the path under test really recorded signals');
    for (const sql of statements) assert.deepEqual(historyScans(sql), [], sql);
  });

  test('the daily GET adds settlement, which reads pending outcomes through their index - never a whole table', async () => {
    clock.advance(24 * 3600000);
    const response = await GET(new Request('https://coin-radar.test/api/goldmine/scheduled', {headers: {authorization: 'Bearer bearer-secret'}}));
    assert.equal(response.status, 200);
    for (const sql of new Set(d1.queries)) assert.deepEqual(historyScans(sql), [], sql);
  });
});

describe('the reads that do scan all history are on-demand dashboard/backtest reads, listed exactly', () => {
  test('readSignalTotals and readTracking\'s stats aggregate scan history; their cost is per page load, not per detection', async () => {
    const {readSignalTotals, readTracking} = await import('../lib/goldmine/signals.ts');
    d1.queries.length = 0;
    await readSignalTotals(d1);
    await readTracking(d1, Date.now());
    const scanning = [...new Set(d1.queries)].filter(sql => historyScans(sql).length);
    assert.equal(scanning.length, 2, scanning.join('\n'));
    assert.ok(scanning.some(sql => sql.includes('COUNT(*) AS signals')));
    assert.ok(scanning.some(sql => sql.includes('derived_status')));
  });
});
