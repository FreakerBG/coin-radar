// POST /api/goldmine/scheduled: the automated entry point to the same scan pipeline as the signed-in
// POST /api/goldmine, authorized instead by a dedicated, fail-closed secret (there is no ChatGPT session
// or Origin header on an automated call). It shares the same `goldmine:scan` lock, so a manual and an
// automated scan can never run concurrently, and the same idempotent signal/outcome handling.
import assert from 'node:assert/strict';
import {beforeEach, describe, test} from 'node:test';
import {addresses, body, createD1, failures, installFetch, jsonRequest, runtime, signIn, startClock} from './helpers/harness.mjs';
import {pair} from './helpers/goldmine-fixtures.mjs';

const {POST: scheduledPost} = await import('../app/api/goldmine/scheduled/route.ts');
const {POST: manualPost} = await import('../app/api/goldmine/route.ts');
const {MODEL_VERSION} = await import('../lib/goldmine/score.ts');
const {SCHEDULED_SECRET_HEADER} = await import('../lib/goldmine/scheduled-auth.ts');

const MINUTE = 60000, HOUR = 60 * MINUTE;
let d1, clock, calls, feeds, outcomePools;

function scheduledRequest({secret = 'topsecret', headers} = {}) {
  const h = new Headers(headers);
  if (secret !== null && !h.has(SCHEDULED_SECRET_HEADER)) h.set(SCHEDULED_SECRET_HEADER, secret);
  return new Request('https://coin-radar.test/api/goldmine/scheduled', {method: 'POST', headers: h});
}
const scheduled = (options) => scheduledPost(scheduledRequest(options));
const manualScan = () => manualPost(jsonRequest('/api/goldmine', {method: 'POST', body: {}}));
const signals = () => d1.rows('SELECT id, address, state FROM goldmine_signals ORDER BY address');

function discoveryPairs() {
  const now = Date.now();
  return [pair({pairCreatedAt: now - 48 * HOUR})];
}
const outcomePool = (pairAddress, token, priceUsd, liquidity = 140000) => ({chainId: 'solana', pairAddress, baseToken: {address: token}, priceUsd, liquidity: {usd: liquidity}});

beforeEach(() => {
  clock = startClock();
  d1 = createD1();
  runtime.env.DB = d1;
  runtime.env.GOLDMINE_CRON_SECRET = 'topsecret';
  failures.length = 0;
  signIn('user-a');
  feeds = {
    profiles: () => Response.json([{chainId: 'solana', tokenAddress: addresses.tokenA}]),
    boosts: () => Response.json([]),
    pairs: () => Response.json(discoveryPairs()),
    safety: () => Response.json({token: {mintAuthority: null, freezeAuthority: null}, rugged: false}),
  };
  outcomePools = () => Response.json({pairs: [outcomePool(addresses.pairA, addresses.tokenA, '0.012')]});
  calls = installFetch(url => {
    if (url.startsWith('https://api.dexscreener.com/token-profiles/')) return feeds.profiles();
    if (url.startsWith('https://api.dexscreener.com/token-boosts/')) return feeds.boosts();
    if (url.startsWith('https://api.dexscreener.com/tokens/v1/solana/')) return feeds.pairs();
    if (url.startsWith('https://api.dexscreener.com/latest/dex/pairs/solana/')) return outcomePools(url);
    if (url.startsWith('https://api.rugcheck.xyz/v1/tokens/')) return feeds.safety(url);
    throw new Error('Unexpected request ' + url);
  });
});

describe('authorization', () => {
  test('the configured secret authorizes a scan, without any ChatGPT session', async () => {
    const response = await scheduled();
    assert.equal(response.status, 200);
    assert.equal((await body(response)).status, 'checked');
  });

  test('a missing header is rejected before any storage or provider call', async () => {
    const response = await scheduled({secret: null});
    assert.equal(response.status, 401);
    assert.deepEqual([d1.queries.length, calls.length], [0, 0]);
  });

  test('a wrong secret is rejected', async () => {
    const response = await scheduled({secret: 'wrong'});
    assert.equal(response.status, 401);
    assert.deepEqual([d1.queries.length, calls.length], [0, 0]);
  });

  test('an unconfigured secret fails closed: no header value, even an empty one, is ever authorized', async () => {
    delete runtime.env.GOLDMINE_CRON_SECRET;
    assert.equal((await scheduled({secret: 'topsecret'})).status, 401);
    assert.equal((await scheduled({headers: {[SCHEDULED_SECRET_HEADER]: ''}})).status, 401);
    assert.deepEqual([d1.queries.length, calls.length], [0, 0]);
  });

  test('an empty configured secret also fails closed (never treated as "any header matches")', async () => {
    runtime.env.GOLDMINE_CRON_SECRET = '';
    assert.equal((await scheduled({headers: {[SCHEDULED_SECRET_HEADER]: ''}})).status, 401);
  });

  test('no Origin header and no ChatGPT session are required - the secret alone authorizes', async () => {
    const request = scheduledRequest();
    assert.equal(request.headers.get('origin'), null);
    const response = await scheduledPost(request);
    assert.equal(response.status, 200);
  });
});

describe('shared lock and pipeline', () => {
  test('a scheduled scan records signals and settles outcomes exactly like the manual scan', async () => {
    const data = await body(await scheduled());
    assert.deepEqual([data.status, data.modelVersion, data.tracking.newSignals], ['checked', MODEL_VERSION, 1]);
    assert.deepEqual(signals().map(row => row.address), [addresses.tokenA]);
    assert.deepEqual(d1.rows('SELECT id FROM research_locks'), [], 'the scan lock is released');
  });

  test('a manual scan holding the lock makes a scheduled scan busy, and vice versa', async () => {
    d1.sqlite.prepare('INSERT INTO research_locks (id, owner, expires) VALUES (?, ?, ?)').run('goldmine:scan', 'manual-scan', clock.now() + 30000);
    assert.deepEqual(await body(await scheduled()), {status: 'busy', candidates: []});
    assert.equal(calls.length, 0);
    d1.sqlite.prepare('DELETE FROM research_locks').run();

    d1.sqlite.prepare('INSERT INTO research_locks (id, owner, expires) VALUES (?, ?, ?)').run('goldmine:scan', 'scheduled-scan', clock.now() + 30000);
    assert.deepEqual(await body(await manualScan()), {status: 'busy', candidates: []});
  });

  test('a signal recorded by a scheduled scan is not recorded again by a manual scan in the same bucket', async () => {
    await scheduled();
    clock.advance(2 * MINUTE);
    const data = await body(await manualScan());
    assert.equal(data.tracking.newSignals, 0);
    assert.equal(signals().length, 1);
  });
});

describe('failure handling', () => {
  test('without the D1 binding, a scheduled scan fails closed before any provider call', async () => {
    delete runtime.env.DB;
    const response = await scheduled();
    assert.deepEqual([response.status, await body(response)], [503, {error: 'Goldmine scan failed.'}]);
    assert.equal(calls.length, 0);
    assert.deepEqual(failures.map(failure => [failure.route, failure.operation, failure.level]), [['goldmine', 'scheduled-scan', 'error']]);
  });

  test('a discovery outage still settles due outcomes and releases the lock', async () => {
    await scheduled();
    clock.advance(16 * MINUTE);
    feeds.profiles = feeds.boosts = () => new Response('unavailable', {status: 503});
    const data = await body(await scheduled());
    assert.deepEqual([data.status, data.candidates, data.tracking.outcomes.observed], ['provider_unavailable', [], 1]);
    assert.deepEqual(d1.rows('SELECT id FROM research_locks'), []);
  });

  test('a storage failure during recording is reported under the scheduled-scan operation and still releases the lock', async () => {
    d1.beforeQuery = sql => { if (sql.startsWith('INSERT OR IGNORE INTO goldmine_signals')) throw new Error('D1_ERROR: write failed'); };
    const response = await scheduled();
    assert.equal(response.status, 503);
    assert.deepEqual(d1.rows('SELECT id FROM research_locks'), []);
    assert.deepEqual(failures.map(failure => [failure.operation, failure.error.message]), [['scheduled-scan', 'D1_ERROR: write failed']]);
  });
});

describe('missed outcome windows without a scan in between', () => {
  test('a gap wider than a window leaves that horizon missed, exactly as it would for the manual route', async () => {
    await scheduled();
    const detected = clock.now();
    // No scan runs between detection and 80 minutes later: past both the 15m window (15-20 minutes)
    // and the 1h window (60-75 minutes). Neither is ever back-filled with this later price.
    clock.advance(80 * MINUTE);
    const late = await body(await scheduled());
    assert.deepEqual([late.tracking.outcomes.missed, late.tracking.outcomes.observed], [2, 0]);
    const statuses = d1.rows("SELECT horizon, status FROM goldmine_outcomes o JOIN goldmine_signals s ON s.id = o.signal_id WHERE s.detected_at = ? ORDER BY horizon", detected);
    assert.deepEqual(statuses.map(row => [row.horizon, row.status]), [['15m', 'missed'], ['1h', 'missed'], ['24h', 'pending'], ['6h', 'pending']]);
  });
});
