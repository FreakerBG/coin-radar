// app/api/goldmine/scheduled/route.ts: the daily GET settles outcomes before detection, whereas
// an intraday POST detects only. Both use the same shared lock, authorized only by
// lib/goldmine/scheduled-auth.ts - never by sign-in or sameOrigin(), since there is no browser here.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { addresses, body, createD1, failures, installFetch, runtime, startClock } from './helpers/harness.mjs';
import { pair } from './helpers/goldmine-fixtures.mjs';

const { GET, POST } = await import('../app/api/goldmine/scheduled/route.ts');
const { MODEL_VERSION } = await import('../lib/goldmine/score.ts');

const ORIGIN = 'https://coin-radar.test';
const ORIGINAL_CRON = process.env.GOLDMINE_CRON_SECRET;
const ORIGINAL_BEARER = process.env.CRON_SECRET;

let d1, calls, clock;

function request(method, headers = {}) {
  return new Request(`${ORIGIN}/api/goldmine/scheduled`, { method, headers });
}

beforeEach(() => {
  clock = startClock();
  d1 = createD1();
  runtime.env.DB = d1;
  failures.length = 0;
  process.env.GOLDMINE_CRON_SECRET = 'header-secret';
  process.env.CRON_SECRET = 'bearer-secret';
  calls = installFetch(url => {
    if (url.startsWith('https://api.dexscreener.com/token-profiles/')) return Response.json([{ chainId: 'solana', tokenAddress: addresses.tokenA }]);
    if (url.startsWith('https://api.dexscreener.com/token-boosts/')) return Response.json([]);
    if (url.startsWith('https://api.dexscreener.com/tokens/v1/solana/')) return Response.json([pair({ pairCreatedAt: Date.now() - 48 * 3600000 })]);
    if (url.startsWith('https://api.dexscreener.com/latest/dex/pairs/solana/')) return Response.json({pairs: [pair({pairCreatedAt: Date.now() - 48 * 3600000})]});
    if (url.startsWith('https://api.rugcheck.xyz/v1/tokens/')) return Response.json({ token: { mintAuthority: null, freezeAuthority: null }, rugged: false });
    throw new Error('Unexpected request ' + url);
  });
});

afterEach(() => {
  if (ORIGINAL_CRON === undefined) delete process.env.GOLDMINE_CRON_SECRET;
  else process.env.GOLDMINE_CRON_SECRET = ORIGINAL_CRON;
  if (ORIGINAL_BEARER === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_BEARER;
});

describe('authorization', () => {
  test('GET (Vercel Cron) with no credentials is rejected before any storage or provider call', async () => {
    const response = await GET(request('GET'));
    assert.equal(response.status, 401);
    assert.deepEqual([d1.queries.length, calls.length], [0, 0]);
  });

  test('GET authorizes via Authorization: Bearer <CRON_SECRET>, the Vercel Cron convention', async () => {
    const response = await GET(request('GET', { authorization: 'Bearer bearer-secret' }));
    assert.equal(response.status, 200);
    assert.equal((await body(response)).status, 'checked');
  });

  test('GET also authorizes via the custom header, not just the Bearer convention', async () => {
    const response = await GET(request('GET', { 'x-goldmine-cron-secret': 'header-secret' }));
    assert.equal(response.status, 200);
  });

  test('POST authorizes via either convention too', async () => {
    assert.equal((await POST(request('POST', { 'x-goldmine-cron-secret': 'header-secret' }))).status, 200);
  });

  test('a wrong secret on either convention is rejected', async () => {
    assert.equal((await GET(request('GET', { authorization: 'Bearer wrong' }))).status, 401);
    assert.equal((await GET(request('GET', { 'x-goldmine-cron-secret': 'wrong' }))).status, 401);
  });

  test('without either GOLDMINE_CRON_SECRET or CRON_SECRET configured, every request is rejected', async () => {
    delete process.env.GOLDMINE_CRON_SECRET;
    delete process.env.CRON_SECRET;
    assert.equal((await GET(request('GET', { authorization: 'Bearer anything' }))).status, 401);
    assert.equal((await GET(request('GET', { 'x-goldmine-cron-secret': 'anything' }))).status, 401);
  });
  // A real owner session cookie not substituting for the secret is already covered, more precisely
  // than a hand-rolled test here could, by tests/vercel-runtime-boundaries.test.mjs's
  // "a valid owner session cookie does not authorize a scheduled scan" - it signs a genuine cookie
  // with createOwnerSession() rather than mocking generic sign-in state.
});

describe('pipeline and lock, once authorized', () => {
  test('runs the same scan pipeline as the interactive route and records signals', async () => {
    const response = await GET(request('GET', { authorization: 'Bearer bearer-secret' }));
    const data = await body(response);
    assert.equal(data.status, 'checked');
    assert.equal(data.modelVersion, MODEL_VERSION);
    assert.equal(data.tracking.newSignals, 1);
    assert.deepEqual(d1.rows('SELECT id FROM research_locks'), [], 'the shared lock is released');
  });

  test('POST records detections but does not evaluate due outcomes; the daily GET does', async () => {
    const credential = { 'x-goldmine-cron-secret': 'header-secret' };
    const first = await body(await POST(request('POST', credential)));
    assert.equal(first.status, 'checked');
    assert.deepEqual(first.tracking, {newSignals: 1, outcomes: null});
    const id = d1.rows('SELECT id FROM goldmine_signals')[0].id;
    clock.advance(24 * 3600_000);
    const before = calls.length;
    const intraday = await body(await POST(request('POST', credential)));
    assert.equal(intraday.tracking.outcomes, null);
    assert.deepEqual(d1.rows('SELECT status FROM goldmine_outcomes WHERE signal_id = ? AND horizon = ?', id, 'd1'), [{status: 'pending'}]);
    assert.equal(calls.slice(before).filter(call => call.url.includes('/latest/dex/pairs/')).length, 0, 'POST must not fetch outcome prices');
    const daily = await body(await GET(request('GET', {authorization: 'Bearer bearer-secret'})));
    assert.equal(daily.tracking.outcomes.observed, 1);
    assert.deepEqual(d1.rows('SELECT status FROM goldmine_outcomes WHERE signal_id = ? AND horizon = ?', id, 'd1'), [{status: 'observed'}]);
  });

  test('96 intraday invocations keep outcome rows pending and use the existing six-hour signal buckets', async () => {
    const credential = {'x-goldmine-cron-secret': 'header-secret'};
    for (let index = 0; index < 96; index++) {
      const result = await body(await POST(request('POST', credential)));
      assert.equal(result.status, 'checked');
      assert.equal(result.tracking.outcomes, null);
      clock.advance(15 * 60_000);
    }
    assert.equal(d1.rows('SELECT id FROM goldmine_signals').length, 4);
    assert.deepEqual(d1.rows('SELECT DISTINCT status FROM goldmine_outcomes'), [{status: 'pending'}]);
    assert.equal(calls.filter(call => call.url.includes('/latest/dex/pairs/')).length, 0);
  });

  // The reverse direction (a scheduled scan blocking the interactive route) is proven by
  // tests/goldmine-route.test.mjs's "another scan holding the lock makes this one busy" test:
  // acquireLock() (lib/research-db.ts) is a plain lease keyed only by lock id, indifferent to which
  // caller took it, so a pre-seeded row is equally valid evidence regardless of which route's test
  // file plants it or what it names the owner.
  test('shares the goldmine:scan lock with the interactive route: a scan already holding it makes this one busy', async () => {
    d1.sqlite.prepare('INSERT INTO research_locks (id, owner, expires) VALUES (?, ?, ?)').run('goldmine:scan', 'interactive-scan', Date.now() + 30000);
    const response = await GET(request('GET', { authorization: 'Bearer bearer-secret' }));
    assert.deepEqual(await body(response), { status: 'busy', candidates: [] });
    assert.equal(calls.length, 0);
  });

  test('without the D1 binding (misconfigured Vercel/Turso), the request fails closed before any provider call', async () => {
    delete runtime.env.DB;
    const response = await GET(request('GET', { authorization: 'Bearer bearer-secret' }));
    assert.deepEqual([response.status, await body(response)], [503, { error: 'Goldmine scan failed.' }]);
    assert.equal(calls.length, 0);
    assert.deepEqual(failures.map(failure => [failure.route, failure.operation]), [['goldmine', 'scheduled-scan']]);
  });
});
