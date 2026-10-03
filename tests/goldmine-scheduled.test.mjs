// app/api/goldmine/scheduled/route.ts: the daily GET settles outcomes before detection, whereas
// an intraday POST detects only. Both use the same shared lock, authorized only by
// lib/goldmine/scheduled-auth.ts - never by sign-in or sameOrigin(), since there is no browser here.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { addresses, body, createD1, failures, installFetch, runtime, scanOutcomes, startClock } from './helpers/harness.mjs';
import { pair } from './helpers/goldmine-fixtures.mjs';

const { GET, POST } = await import('../app/api/goldmine/scheduled/route.ts');
const { MODEL_VERSION } = await import('../lib/goldmine/score.ts');
const { RUGCHECK_COOLDOWN_MS } = await import('../lib/goldmine/contract-safety.ts');

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
  scanOutcomes.length = 0;
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

  // Stage 09A adds reviewEvidence to the signed-in interactive response only. The scheduled responses,
  // which the scheduler Worker receives, must not change shape.
  test('neither scheduled response carries reviewEvidence', async () => {
    const daily = await (await GET(request('GET', { authorization: 'Bearer bearer-secret' }))).text();
    clock.advance(6 * 3600000);
    const detection = await (await POST(request('POST', { 'x-goldmine-cron-secret': 'header-secret' }))).text();
    for (const raw of [daily, detection]) {
      assert.ok(JSON.parse(raw).candidates.length > 0, 'the fixture produces candidates, so absence is meaningful');
      assert.equal(raw.includes('reviewEvidence'), false);
    }
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

  test('96 intraday invocations against a RugCheck that always 429s: detection keeps working, and the persisted cooldown roughly halves the wasted requests', async () => {
    const credential = {'x-goldmine-cron-secret': 'header-secret'};
    const providerCalls = installFetch(url => {
      if (url.startsWith('https://api.dexscreener.com/token-profiles/')) return Response.json([{ chainId: 'solana', tokenAddress: addresses.tokenA }]);
      if (url.startsWith('https://api.dexscreener.com/token-boosts/')) return Response.json([]);
      if (url.startsWith('https://api.dexscreener.com/tokens/v1/solana/')) return Response.json([pair({ pairCreatedAt: Date.now() - 48 * 3600000 })]);
      if (url.startsWith('https://api.rugcheck.xyz/v1/tokens/')) return new Response('rate limited', { status: 429 });
      throw new Error('Unexpected request ' + url);
    });
    for (let index = 0; index < 96; index++) {
      const result = await body(await POST(request('POST', credential)));
      assert.equal(result.status, 'checked', 'a rate-limited safety provider never blocks detection itself');
      clock.advance(15 * 60_000);
    }
    const rugcheckAttempts = providerCalls.filter(call => call.url.includes('rugcheck.xyz')).length;
    // Without the persisted cooldown this would be 96 (one wasted request per invocation, since each is a
    // fresh call with no shared in-memory rate-limit state). RUGCHECK_COOLDOWN_MS is twice the 15-minute
    // cadence (see its comment in lib/goldmine/contract-safety.ts), so a request is retried roughly every
    // other invocation once a cooldown is active: 48 attempts across the day, not an exact guarantee for
    // every possible timing, but well under half of doing nothing at all.
    assert.ok(rugcheckAttempts > 0 && rugcheckAttempts <= 50, `expected roughly 48 attempts, got ${rugcheckAttempts}`);
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

describe('settlement-demand metric: distinct pairs, not signals (lib/goldmine/signals.ts pairMetrics)', () => {
  const credential = { 'x-goldmine-cron-secret': 'header-secret' };
  const outcome = () => scanOutcomes.at(-1);
  const discover = tokens => installFetch(url => {
    if (url.startsWith('https://api.dexscreener.com/token-profiles/')) return Response.json(tokens.map(t => ({ chainId: 'solana', tokenAddress: t.token })));
    if (url.startsWith('https://api.dexscreener.com/token-boosts/')) return Response.json([]);
    if (url.startsWith('https://api.dexscreener.com/tokens/v1/solana/')) return Response.json(tokens.map(t => pair({ pairAddress: t.pair, baseToken: { address: t.token, name: 'T', symbol: 'T' }, pairCreatedAt: Date.now() - 48 * 3600000 })));
    if (url.startsWith('https://api.dexscreener.com/latest/dex/pairs/solana/')) return Response.json({ pairs: [] });
    if (url.startsWith('https://api.rugcheck.xyz/v1/tokens/')) return Response.json({ token: { mintAuthority: null, freezeAuthority: null }, rugged: false });
    throw new Error('Unexpected request ' + url);
  });
  const A = { token: addresses.tokenA, pair: addresses.pairA }, B = { token: addresses.tokenB, pair: addresses.pairB };

  test('a repeat of the same pair adds a signal in a new six-hour bucket but not a new pair; a second pair does', async () => {
    discover([A]);
    await POST(request('POST', credential));
    assert.deepEqual([outcome().newSignals, outcome().pairs24h, outcome().newPairs], [1, 1, 1]);

    clock.advance(15 * 60_000);
    await POST(request('POST', credential));
    assert.deepEqual([outcome().newSignals, outcome().pairs24h, outcome().newPairs], [0, 1, 0], 'same bucket: no signal, no pair');

    clock.advance(6 * 3600_000);
    await POST(request('POST', credential));
    assert.deepEqual([outcome().newSignals, outcome().pairs24h, outcome().newPairs], [1, 1, 0], 'new bucket: a new SIGNAL, but the same PAIR');

    discover([A, B]);
    clock.advance(15 * 60_000);
    await POST(request('POST', credential));
    assert.deepEqual([outcome().pairs24h, outcome().newPairs], [2, 1]);
  });

  test('the window is a rolling 24 hours: pairs last seen more than 24 hours ago no longer count', async () => {
    discover([A, B]);
    await POST(request('POST', credential));
    assert.equal(outcome().pairs24h, 2);
    clock.advance(25 * 3600_000);
    discover([A]);
    await POST(request('POST', credential));
    assert.deepEqual([outcome().pairs24h, outcome().newPairs], [1, 1], 'A counts as new again: its last signal is outside the window');
  });

  test('the daily GET reports the same metric; busy and provider_unavailable report none', async () => {
    discover([A]);
    await GET(request('GET', { authorization: 'Bearer bearer-secret' }));
    assert.deepEqual([outcome().mode, outcome().pairs24h, outcome().newPairs], ['daily', 1, 1]);
    d1.sqlite.prepare('INSERT INTO research_locks (id, owner, expires) VALUES (?, ?, ?)').run('goldmine:scan', 'other', Date.now() + 30000);
    await POST(request('POST', credential));
    assert.equal(outcome().status, 'busy');
    assert.equal('pairs24h' in outcome(), false);
    d1.sqlite.prepare('DELETE FROM research_locks').run();
    clock.advance(5 * 60_000); // past lib/market.ts's discovery cache, so the outage is actually seen
    installFetch(() => { throw new Error('network down'); });
    await POST(request('POST', credential));
    assert.equal(outcome().status, 'provider_unavailable');
    assert.equal('pairs24h' in outcome(), false);
  });

  test('a failed metric query never changes the scan: it is logged as null with a warn record', async () => {
    discover([A]);
    d1.beforeQuery = sql => { if (sql.includes('GROUP BY pair, address')) throw new Error('D1_ERROR: metric read failed'); };
    const response = await POST(request('POST', credential));
    d1.beforeQuery = null;
    assert.equal(response.status, 200);
    assert.equal((await body(response)).status, 'checked');
    assert.deepEqual([outcome().pairs24h, outcome().newPairs], [null, null]);
    assert.deepEqual(failures.map(f => [f.operation, f.level]), [['pair-metrics', 'warn']]);
  });
});

// installFetch fully replaces global fetch, so discovery/outcome/RugCheck all need re-declaring together
// whenever a test wants to vary just one of them (here, RugCheck's response).
function installProviders(rugcheck) {
  return installFetch(url => {
    if (url.startsWith('https://api.dexscreener.com/token-profiles/')) return Response.json([{ chainId: 'solana', tokenAddress: addresses.tokenA }]);
    if (url.startsWith('https://api.dexscreener.com/token-boosts/')) return Response.json([]);
    if (url.startsWith('https://api.dexscreener.com/tokens/v1/solana/')) return Response.json([pair({ pairCreatedAt: Date.now() - 48 * 3600000 })]);
    if (url.startsWith('https://api.dexscreener.com/latest/dex/pairs/solana/')) return Response.json({ pairs: [pair({ pairCreatedAt: Date.now() - 48 * 3600000 })] });
    if (url.startsWith('https://api.rugcheck.xyz/v1/tokens/')) return rugcheck();
    throw new Error('Unexpected request ' + url);
  });
}
const rugcheckVerified = () => Response.json({ token: { mintAuthority: null, freezeAuthority: null }, rugged: false });
const rugcheckRateLimited = () => new Response('rate limited', { status: 429 });

describe('explicit scan-outcome metrics (lib/diagnostics.ts reportScanOutcome)', () => {
  const outcome = (mode, status) => ({ event: 'coin_radar.scan_outcome', route: 'goldmine-scheduled', mode, status });
  const head = record => ({ event: record.event, route: record.route, mode: record.mode, status: record.status });

  test('a checked GET and a checked POST each log their own route/mode/status, once', async () => {
    await GET(request('GET', { authorization: 'Bearer bearer-secret' }));
    await POST(request('POST', { 'x-goldmine-cron-secret': 'header-secret' }));
    assert.deepEqual(scanOutcomes.map(head), [outcome('daily', 'checked'), outcome('detection', 'checked')]);
  });

  test('a checked outcome carries duration, counts and contract-safety coverage - numbers and enums only, never an address or a secret', async () => {
    await GET(request('GET', { authorization: 'Bearer bearer-secret' }));
    await POST(request('POST', { 'x-goldmine-cron-secret': 'header-secret' }));
    const [daily, detection] = scanOutcomes;
    assert.equal(daily.outcomesSettled, true, 'the daily GET settles outcomes');
    assert.equal(detection.outcomesSettled, false, 'the detection POST never does');
    for (const record of [daily, detection]) {
      assert.equal(typeof record.durationMs, 'number');
      assert.equal(record.candidates, 1);
      assert.equal(record.opportunities, 0);
      assert.deepEqual(Object.keys(record.safety).sort(), ['cacheHits', 'cooldown', 'eligible', 'rateLimited', 'requests', 'unavailable', 'unchecked', 'unsafe', 'verified']);
      assert.equal(record.safety.cooldown, 'none');
      const text = JSON.stringify(record);
      for (const secret of [addresses.tokenA, addresses.pairA, 'header-secret', 'bearer-secret']) assert.equal(text.includes(secret), false, secret);
    }
    assert.equal(daily.newSignals, 1);
    assert.equal(detection.newSignals, 0, 'the same six-hour bucket collapses the repeat');
    assert.equal(daily.safety.requests + daily.safety.cacheHits, daily.safety.eligible - daily.safety.unchecked);
  });

  test('a lock already held logs busy and never reaches the pipeline', async () => {
    d1.sqlite.prepare('INSERT INTO research_locks (id, owner, expires) VALUES (?, ?, ?)').run('goldmine:scan', 'other', Date.now() + 30000);
    await GET(request('GET', { authorization: 'Bearer bearer-secret' }));
    assert.deepEqual(scanOutcomes.map(head), [outcome('daily', 'busy')]);
    assert.equal(typeof scanOutcomes[0].durationMs, 'number');
    assert.equal(scanOutcomes[0].safety, undefined);
    assert.equal(calls.length, 0);
  });

  test('a discovery-provider failure logs provider_unavailable, not checked', async () => {
    installFetch(() => { throw new Error('network down'); });
    await POST(request('POST', { 'x-goldmine-cron-secret': 'header-secret' }));
    assert.deepEqual(scanOutcomes.map(head), [outcome('detection', 'provider_unavailable')]);
    assert.equal(scanOutcomes[0].safety, undefined, 'nothing was scored, so there is no safety coverage to claim');
    assert.equal(scanOutcomes[0].newSignals, 0);
  });

  test('an unauthorized request, or one that fails before a result exists, logs no scan outcome at all', async () => {
    await GET(request('GET'));
    delete runtime.env.DB;
    await GET(request('GET', { authorization: 'Bearer bearer-secret' }));
    assert.deepEqual(scanOutcomes, []);
  });
});

describe('the persisted RugCheck cooldown (lib/goldmine/contract-safety.ts) across scheduled invocations', () => {
  test('a 429 on one intraday POST suppresses RugCheck on the next scheduled invocation 15 minutes later, then resumes once the cooldown elapses', async () => {
    const credential = { 'x-goldmine-cron-secret': 'header-secret' };
    installProviders(rugcheckRateLimited);
    await POST(request('POST', credential)); // gets 429, starts the persisted cooldown

    clock.advance(15 * 60_000); // the target intraday cadence
    const stillCoolingDown = installProviders(rugcheckVerified); // would happily verify, if asked
    const midCooldown = await body(await POST(request('POST', credential)));
    assert.equal(midCooldown.status, 'checked', 'detection itself keeps running; only the RugCheck check is skipped');
    assert.equal(stillCoolingDown.filter(call => call.url.includes('rugcheck.xyz')).length, 0);

    clock.advance(RUGCHECK_COOLDOWN_MS);
    const afterCooldown = installProviders(rugcheckVerified);
    await POST(request('POST', credential));
    assert.ok(afterCooldown.some(call => call.url.includes('rugcheck.xyz')), 'the cooldown has elapsed, so RugCheck is asked again');
  });

  test('the response and log report the 429 and then the active cooldown, so a checked scan never hides missing safety coverage', async () => {
    const credential = { 'x-goldmine-cron-secret': 'header-secret' };
    installProviders(rugcheckRateLimited);
    const limited = await body(await POST(request('POST', credential)));
    assert.equal(limited.status, 'checked');
    assert.equal(limited.safety.rateLimited, true);
    assert.equal(limited.safety.requests, 1);
    assert.equal(limited.safety.verified, 0);

    clock.advance(15 * 60_000);
    installProviders(rugcheckVerified);
    const cooling = await body(await POST(request('POST', credential)));
    assert.equal(cooling.safety.cooldown, 'active');
    assert.equal(cooling.safety.requests, 0);
    assert.deepEqual(scanOutcomes.map(record => [record.status, record.safety.rateLimited, record.safety.cooldown]), [['checked', true, 'none'], ['checked', false, 'active']]);
  });

  test('the cooldown row never interferes with the goldmine:scan lease: the lease is released after a 429 scan and is not held by an active cooldown', async () => {
    const credential = { 'x-goldmine-cron-secret': 'header-secret' };
    installProviders(rugcheckRateLimited);
    await POST(request('POST', credential));
    assert.deepEqual(d1.rows('SELECT id FROM research_locks ORDER BY id'), [{ id: 'goldmine:rugcheck-cooldown' }], 'only the cooldown remains; the scan lease was released');

    // With the cooldown still active, the next scan is not "busy" - the lease is keyed only by its own id.
    const next = await body(await POST(request('POST', credential)));
    assert.equal(next.status, 'checked');
    assert.deepEqual(d1.rows('SELECT id FROM research_locks ORDER BY id'), [{ id: 'goldmine:rugcheck-cooldown' }], 'releasing the lease never deletes the cooldown');
  });
});
