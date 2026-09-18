// /api/goldmine: signed-in scans that score DEX Screener candidates, record signals with the detection
// price, and settle 15m/1h/6h/24h outcomes only inside their windows. DEX Screener is a local fetch double.
import assert from 'node:assert/strict';
import {beforeEach, describe, test} from 'node:test';
import {addresses, body, createD1, failures, installFetch, jsonRequest, runtime, signIn, signOut, startClock} from './helpers/harness.mjs';
import {pair} from './helpers/goldmine-fixtures.mjs';

const {GET, POST} = await import('../app/api/goldmine/route.ts');
const {MODEL_VERSION} = await import('../lib/goldmine/score.ts');

const MINUTE = 60000, HOUR = 60 * MINUTE;
let d1, clock, calls, feeds, outcomePools;

const scan = origin => POST(jsonRequest('/api/goldmine', {method: 'POST', body: {}, origin}));
const read = () => GET(jsonRequest('/api/goldmine'));
const signals = () => d1.rows('SELECT id, address, state, score, opportunity, detected_at, detected_price FROM goldmine_signals ORDER BY address, detected_at');
const outcomes = () => d1.rows('SELECT o.horizon, o.status, o.due_at, o.deadline_at, o.observed_at, o.price, s.address, s.detected_at FROM goldmine_outcomes o JOIN goldmine_signals s ON s.id = o.signal_id ORDER BY s.address, o.due_at');

// Token A: the reference BREAKOUT. Token B: promoted and too thin, so REJECTED. The pairs are built at
// scan time so pool ages follow the test clock.
function discoveryPairs() {
  const now = Date.now();
  return [
    pair({pairCreatedAt: now - 48 * HOUR}),
    pair({pairAddress: addresses.pairB, baseToken: {address: addresses.tokenB, name: 'Thin', symbol: 'THIN'}, liquidity: {usd: 10000}, volume: {h24: 50000}, pairCreatedAt: now - 48 * HOUR, priceUsd: '2'}),
  ];
}
const outcomePool = (pairAddress, token, priceUsd, liquidity = 140000) => ({chainId: 'solana', pairAddress, baseToken: {address: token}, priceUsd, liquidity: {usd: liquidity}});

beforeEach(() => {
  clock = startClock();
  d1 = createD1();
  runtime.env.DB = d1;
  failures.length = 0;
  signIn('user-a');
  feeds = {
    profiles: () => Response.json([{chainId: 'solana', tokenAddress: addresses.tokenA}, {chainId: 'solana', tokenAddress: addresses.tokenB}]),
    boosts: () => Response.json([{chainId: 'solana', tokenAddress: addresses.tokenB}]),
    pairs: () => Response.json(discoveryPairs()),
    // A real but empty RugCheck report by default: every test below that predates Stage 03B keeps
    // scoring contractSafety as unavailable, exactly as before it existed, without logging a failure
    // record (this is success with nothing usable yet, not a provider error). Tests about contract
    // safety itself (tests/goldmine-contract-safety.test.mjs) override this.
    safety: () => Response.json({token: {mintAuthority: null, freezeAuthority: null}, rugged: false}),
  };
  outcomePools = () => Response.json({pairs: [outcomePool(addresses.pairA, addresses.tokenA, '0.012'), outcomePool(addresses.pairB, addresses.tokenB, '1.5')]});
  calls = installFetch(url => {
    if (url.startsWith('https://api.dexscreener.com/token-profiles/')) return feeds.profiles();
    if (url.startsWith('https://api.dexscreener.com/token-boosts/')) return feeds.boosts();
    if (url.startsWith('https://api.dexscreener.com/tokens/v1/solana/')) return feeds.pairs();
    if (url.startsWith('https://api.dexscreener.com/latest/dex/pairs/solana/')) return outcomePools(url);
    if (url.startsWith('https://api.rugcheck.xyz/v1/tokens/')) return feeds.safety(url);
    throw new Error('Unexpected request ' + url);
  });
});

describe('access', () => {
  test('sign-in and same-origin are required before storage or provider calls', async () => {
    signOut();
    assert.equal((await scan()).status, 401);
    assert.equal((await read()).status, 401);
    signIn('user-a');
    assert.equal((await scan('https://attacker.test')).status, 403);
    assert.equal((await scan(null)).status, 403);
    assert.deepEqual([d1.queries.length, calls.length], [0, 0]);
  });

  test('without the D1 binding (the Vercel preview) both methods fail closed before any provider call', async () => {
    delete runtime.env.DB;
    const scanned = await scan();
    assert.deepEqual([scanned.status, await body(scanned)], [503, {error: 'Goldmine scan failed.'}]);
    assert.equal((await read()).status, 503);
    assert.equal(calls.length, 0);
    assert.deepEqual(failures.map(failure => [failure.route, failure.operation, failure.level]), [['goldmine', 'scan', 'error'], ['goldmine', 'load', 'error']]);
  });
});

describe('scanning', () => {
  test('scores every discovered token, explains it and records the detection price', async () => {
    const response = await scan();
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = await body(response);
    assert.deepEqual([data.status, data.modelVersion, data.opportunities, data.tracking], ['checked', MODEL_VERSION, 0, {newSignals: 2, outcomes: {provider: 'not_needed', observed: 0, unavailable: 0, missed: 0, deferred: 0}}]);
    assert.deepEqual(data.candidates.map(c => [c.address, c.state, c.score, c.opportunity]), [[addresses.tokenA, 'BREAKOUT', 81, false], [addresses.tokenB, 'REJECTED', data.candidates[1].score, false]]);
    const [a, b] = data.candidates;
    assert.deepEqual(a.blockers.map(gate => gate.id), ['contract_safety_unverified']);
    assert.ok(b.rejections.some(gate => gate.id === 'thin_liquidity'));
    assert.equal(b.components.find(part => part.id === 'social_momentum').evidence[0], 'Paid DEX Screener promotion is active; promotion is not organic momentum (+0).');
    assert.deepEqual([a.snapshot.priceUsd, b.snapshot.promoted], [0.01, true]);

    const now = clock.now();
    assert.deepEqual(signals().map(row => [row.address, row.state, row.score, row.opportunity, row.detected_at, row.detected_price]),
      [[addresses.tokenA, 'BREAKOUT', 81, 0, now, 0.01], [addresses.tokenB, 'REJECTED', b.score, 0, now, 2]]);
    assert.deepEqual(outcomes().filter(row => row.address === addresses.tokenA).map(row => [row.horizon, row.status, row.due_at - now, row.deadline_at - now]), [
      ['15m', 'pending', 15 * MINUTE, 20 * MINUTE], ['1h', 'pending', HOUR, HOUR + 15 * MINUTE], ['6h', 'pending', 6 * HOUR, 7 * HOUR], ['24h', 'pending', 24 * HOUR, 27 * HOUR],
    ]);
    const [stored] = d1.rows('SELECT snapshot, assessment FROM goldmine_signals WHERE address = ?', addresses.tokenA);
    const {snapshot, ...assessment} = a;
    assert.deepEqual([JSON.parse(stored.snapshot), JSON.parse(stored.assessment)], [snapshot, assessment], 'the stored evidence is exactly what was served');
    assert.deepEqual(d1.rows('SELECT id FROM research_locks'), [], 'the scan lock is released');
  });

  test('stores no user data, so every signed-in user reads the same shared signals', async () => {
    await scan();
    const everything = JSON.stringify([d1.rows('SELECT * FROM goldmine_signals'), d1.rows('SELECT * FROM goldmine_outcomes')]);
    assert.doesNotMatch(everything, /user-a|example\.test/);
    const first = await body(await read());
    signIn('user-b');
    assert.deepEqual(await body(await read()), first);
  });

  test('a persisting pattern is recorded once per six-hour bucket', async () => {
    await scan();
    clock.advance(2 * MINUTE);
    assert.equal((await body(await scan())).tracking.newSignals, 0);
    assert.equal(signals().length, 2);
    clock.advance(6 * HOUR);
    assert.equal((await body(await scan())).tracking.newSignals, 2);
    assert.equal(signals().length, 4);
    assert.equal(outcomes().length, 16);
  });

  test('uses cached public X evidence without requesting X, and never for promoted tokens', async () => {
    for (const address of [addresses.tokenA, addresses.tokenB]) {
      d1.sqlite.prepare('INSERT INTO social_cache (address, data, fetched_at) VALUES (?, ?, ?)').run(address,
        JSON.stringify({address, posts: [], summary: {sampleSize: 20, uniqueAuthors: 15, duplicateText: 1, engagement: 9, warning: 'Bounded sample.'}}), clock.now() - HOUR);
    }
    const data = await body(await scan());
    const social = address => data.candidates.find(c => c.address === address).components.find(part => part.id === 'social_momentum').points;
    assert.deepEqual([social(addresses.tokenA), social(addresses.tokenB)], [10, 0]);
    assert.equal(data.candidates.find(c => c.address === addresses.tokenA).score, 91);
    assert.equal(calls.some(call => call.url.startsWith('https://api.x.com/')), false, 'social evidence never triggers an X request');

    // A malformed cache row is no evidence, not a failure.
    d1.sqlite.prepare('UPDATE social_cache SET data = ? WHERE address = ?').run('{not json', addresses.tokenA);
    clock.advance(2 * MINUTE);
    const again = await body(await scan());
    assert.equal(again.candidates.find(c => c.address === addresses.tokenA).components.find(part => part.id === 'social_momentum').status, 'unavailable');
    assert.deepEqual(failures, []);
  });

  test('a full discovery set is written in bounded chunks of at most 10 signals', async () => {
    const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const tokens = Array.from({length: 25}, (_, index) => 'Mint' + BASE58[index] + 'C'.repeat(39));
    feeds.profiles = () => Response.json(tokens.map(tokenAddress => ({chainId: 'solana', tokenAddress})));
    feeds.boosts = () => Response.json([]);
    feeds.pairs = () => Response.json(tokens.map((token, index) => pair({pairAddress: 'Pair' + BASE58[index] + 'C'.repeat(39), baseToken: {address: token}, pairCreatedAt: Date.now() - 48 * HOUR})));
    const inserts = [];
    d1.beforeQuery = (sql, params) => { if (sql.startsWith('INSERT OR IGNORE INTO goldmine_signals')) inserts.push(params[0]); };
    const data = await body(await scan());
    assert.deepEqual([data.candidates.length, data.tracking.newSignals], [25, 25]);
    assert.deepEqual(inserts.map(json => JSON.parse(json).length), [10, 10, 5]);
    assert.ok(inserts.every(json => json.length < 50000), `largest bound value ${Math.max(...inserts.map(json => json.length))} bytes`);
    assert.deepEqual([signals().length, outcomes().length], [25, 100]);
  });

  test('another scan holding the lock makes this one busy; a failure still releases the lock', async () => {
    d1.sqlite.prepare('INSERT INTO research_locks (id, owner, expires) VALUES (?, ?, ?)').run('goldmine:scan', 'other-scan', clock.now() + 30000);
    assert.deepEqual(await body(await scan()), {status: 'busy', candidates: []});
    assert.equal(calls.length, 0);
    d1.sqlite.prepare('DELETE FROM research_locks').run();

    d1.beforeQuery = sql => { if (sql.startsWith('INSERT OR IGNORE INTO goldmine_signals')) throw new Error('D1_ERROR: write failed'); };
    assert.equal((await scan()).status, 503);
    assert.deepEqual(d1.rows('SELECT id FROM research_locks'), []);
    assert.deepEqual(failures.map(failure => [failure.operation, failure.error.message]), [['scan', 'D1_ERROR: write failed']]);
  });

  test('a discovery outage records nothing and still settles due outcomes', async () => {
    await scan();
    clock.advance(16 * MINUTE);
    feeds.profiles = feeds.boosts = () => new Response('unavailable', {status: 503});
    const data = await body(await scan());
    assert.deepEqual([data.status, data.candidates, data.tracking.newSignals, data.tracking.outcomes.observed], ['provider_unavailable', [], 0, 2]);
    assert.equal(signals().length, 2);
    assert.deepEqual(failures.map(failure => [failure.operation, failure.level]), [['provider', 'warn']]);
  });
});

describe('outcome tracking', () => {
  test('each horizon is observed only inside its window; a late check is missed, never back-filled', async () => {
    await scan();
    const detected = clock.now();
    // Later scans in a new six-hour bucket record new signals; follow the first one only.
    const status = () => Object.fromEntries(outcomes().filter(row => row.address === addresses.tokenA && row.detected_at === detected).map(row => [row.horizon, [row.status, row.price]]));

    clock.advance(10 * MINUTE);
    assert.equal((await body(await scan())).tracking.outcomes.provider, 'not_needed', 'nothing is due before 15 minutes');

    clock.advance(6 * MINUTE);
    assert.deepEqual((await body(await scan())).tracking.outcomes, {provider: 'ok', observed: 2, unavailable: 0, missed: 0, deferred: 0});
    assert.deepEqual(status(), {'15m': ['observed', 0.012], '1h': ['pending', null], '6h': ['pending', null], '24h': ['pending', null]});

    // The next check comes 80 minutes after detection: past the 1h window (60-75 minutes).
    clock.advance(detected + 80 * MINUTE - clock.now());
    outcomePools = () => Response.json({pairs: [outcomePool(addresses.pairA, addresses.tokenA, '0.5'), outcomePool(addresses.pairB, addresses.tokenB, '9')]});
    const late = await body(await scan());
    assert.deepEqual([late.tracking.outcomes.missed, late.tracking.outcomes.observed], [2, 0]);
    assert.deepEqual(status()['1h'], ['missed', null]);

    clock.advance(detected + 6 * HOUR + 30 * MINUTE - clock.now());
    await scan();
    assert.deepEqual(status()['6h'], ['observed', 0.5]);
    const [row] = outcomes().filter(outcome => outcome.address === addresses.tokenA && outcome.detected_at === detected && outcome.horizon === '6h');
    assert.equal(row.observed_at, clock.now());
  });

  test('a pool missing from a successful response is unavailable; a provider failure leaves outcomes pending', async () => {
    await scan();
    clock.advance(16 * MINUTE);
    outcomePools = () => new Response('rate limited', {status: 429});
    const failed = await body(await scan());
    assert.deepEqual(failed.tracking.outcomes, {provider: 'unavailable', observed: 0, unavailable: 0, missed: 0, deferred: 0});
    assert.ok(failures.some(failure => failure.operation === 'outcome-provider' && failure.level === 'warn'));
    assert.equal(outcomes().filter(row => row.horizon === '15m' && row.status === 'pending').length, 2);

    clock.advance(MINUTE);
    outcomePools = () => Response.json({pairs: [outcomePool(addresses.pairA, addresses.tokenA, '0.011'), outcomePool(addresses.pairB, addresses.tokenA, '1'), {chainId: 'ethereum', pairAddress: addresses.pairB, baseToken: {address: addresses.tokenB}, priceUsd: '1'}]});
    assert.deepEqual((await body(await scan())).tracking.outcomes, {provider: 'ok', observed: 1, unavailable: 1, missed: 0, deferred: 0});
    assert.deepEqual(outcomes().filter(row => row.horizon === '15m').map(row => [row.address, row.status, row.price]),
      [[addresses.tokenA, 'observed', 0.011], [addresses.tokenB, 'unavailable', null]]);
  });

  test('GET lists recent signals with ordered outcomes, returns and per-state statistics', async () => {
    await scan();
    clock.advance(16 * MINUTE);
    await scan();
    const response = await read();
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = await body(response);
    assert.equal(data.modelVersion, MODEL_VERSION);
    assert.deepEqual(data.signals.map(signal => [signal.address, signal.state]), [[addresses.tokenA, 'BREAKOUT'], [addresses.tokenB, 'REJECTED']]);
    const a = data.signals[0];
    assert.deepEqual(a.outcomes.map(outcome => [outcome.horizon, outcome.status, outcome.returnPct]), [['15m', 'observed', 20], ['1h', 'pending', null], ['6h', 'pending', null], ['24h', 'pending', null]]);
    assert.equal(a.assessment.summary.startsWith('BREAKOUT · score 81/100.'), true);
    assert.deepEqual(data.signals.map(signal => signal.contractSafety.status), ['unavailable', 'unavailable'], 'the dashboard can read contract safety without a second RugCheck call');
    assert.deepEqual(data.stats.filter(row => row.horizon === '15m'), [
      {state: 'BREAKOUT', horizon: '15m', pending: 0, observed: 1, unavailable: 0, missed: 0, meanReturnPct: 20, positiveShare: 1},
      {state: 'REJECTED', horizon: '15m', pending: 0, observed: 1, unavailable: 0, missed: 0, meanReturnPct: -25, positiveShare: 0},
    ]);
    assert.deepEqual(data.stats.filter(row => row.horizon === '24h').map(row => [row.state, row.pending, row.meanReturnPct]), [['BREAKOUT', 1, null], ['REJECTED', 1, null]]);
  });
});

describe('GET contractSafety: minimal client shape, defensive against malformed or legacy stored snapshots', () => {
  // Inserts one signal row directly, bypassing recordSignals, so the stored `snapshot` column can hold
  // exactly the shape under test (including shapes recordSignals itself would never produce, such as
  // corrupt JSON or a pre-03B snapshot with no contractSafety key at all).
  function seedSignal(id, snapshotRaw) {
    d1.sqlite.prepare('INSERT INTO goldmine_signals (id, address, pair, symbol, model_version, state, score, opportunity, detected_at, detected_price, snapshot, assessment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, addresses.tokenA, addresses.pairA, 'FIX', MODEL_VERSION, 'BREAKOUT', 81, 0, clock.now(), 0.01, snapshotRaw, '{"summary":"BREAKOUT · score 81/100."}');
  }

  test('verified contractSafety exposes only {status}, nothing from facts, source or checkedAt', async () => {
    seedSignal('sig-verified', JSON.stringify({contractSafety: {status: 'verified', source: 'rugcheck', checkedAt: clock.now(), facts: {mintAuthorityRenounced: true}}}));
    const data = await body(await read());
    assert.deepEqual(data.signals[0].contractSafety, {status: 'verified'});
  });

  test('unsafe contractSafety exposes {status, reason} built from our own check messages, never RugCheck facts or provider risk text', async () => {
    seedSignal('sig-unsafe', JSON.stringify({contractSafety: {
      status: 'unsafe', source: 'rugcheck', checkedAt: clock.now(),
      facts: {mintAuthorityRenounced: false, providerRisks: [{name: 'Mutable metadata', level: 'danger', description: 'some RugCheck-authored text that must never reach the client verbatim as facts'}], providerScoreNormalized: 3},
      failedChecks: ['Mint authority is still active.', 'Freeze authority is still active.'],
    }}));
    const data = await body(await read());
    assert.deepEqual(data.signals[0].contractSafety, {status: 'unsafe', reason: 'Mint authority is still active. Freeze authority is still active.'});
    const json = JSON.stringify(data);
    assert.equal(json.includes('facts'), false, 'stored facts must never be serialized to the client');
    assert.equal(json.includes('providerRisks'), false);
    assert.equal(json.includes('providerScoreNormalized'), false);
    assert.equal(json.includes('checkedAt'), false);
    assert.equal(json.includes('rugcheck'), false, 'the provider source/name is not client-facing');
  });

  test('a high score never overrides an unsafe or unavailable status: both stay out of the opportunity set regardless of score/state columns', async () => {
    seedSignal('sig-unsafe-high', JSON.stringify({contractSafety: {status: 'unsafe', source: 'rugcheck', checkedAt: clock.now(), facts: {}, failedChecks: ['RugCheck has recorded this contract as rugged.']}}));
    const data = await body(await read());
    assert.equal(data.signals[0].contractSafety.status, 'unsafe');
    assert.equal(data.signals[0].opportunity, false, 'the stored opportunity flag, not contractSafety, decides this - and a rugged/unsafe candidate was never recorded as an opportunity');
  });

  test('unavailable contractSafety is the safe default for a snapshot missing the field entirely (a pre-03B signal)', async () => {
    seedSignal('sig-legacy', JSON.stringify({address: addresses.tokenA})); // no contractSafety key at all
    const data = await body(await read());
    assert.deepEqual(data.signals[0].contractSafety, {status: 'unavailable'});
  });

  test('corrupt JSON in the stored snapshot degrades to unavailable for that row, and never crashes the whole read', async () => {
    seedSignal('sig-corrupt', '{not valid json');
    const response = await read();
    assert.equal(response.status, 200);
    const data = await body(response);
    assert.deepEqual(data.signals[0].contractSafety, {status: 'unavailable'});
  });

  test('an unrecognized status string (future/foreign schema) is never read as verified or safe', async () => {
    seedSignal('sig-unknown-status', JSON.stringify({contractSafety: {status: 'pending-review'}}));
    const data = await body(await read());
    assert.deepEqual(data.signals[0].contractSafety, {status: 'unavailable'});
  });
});

describe('outcome batches', () => {
  const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const pairAddress = index => 'Pair' + BASE58[Math.floor(index / BASE58.length)] + BASE58[index % BASE58.length] + 'B'.repeat(38);
  let requests;

  // `count` signals detected 16 minutes ago, one pool each, whose 15m outcomes are due now. Signal i was
  // detected i seconds earlier than signal i+1, so its window closes first.
  function seedDue(count) {
    const now = clock.now();
    for (let index = 0; index < count; index++) {
      const detected = now - 16 * MINUTE - (count - index) * 1000;
      const id = `batch-signal-${String(index).padStart(3, '0')}`;
      d1.sqlite.prepare('INSERT INTO goldmine_signals (id, address, pair, symbol, model_version, state, score, opportunity, detected_at, detected_price, snapshot, assessment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, addresses.tokenA, pairAddress(index), 'FIX', MODEL_VERSION, 'BUILDING', 60, 0, detected, 1, '{}', '{}');
      d1.sqlite.prepare('INSERT INTO goldmine_outcomes (signal_id, horizon, due_at, deadline_at) VALUES (?, ?, ?, ?)').run(id, '15m', detected + 15 * MINUTE, detected + 20 * MINUTE);
    }
    return Array.from({length: count}, (_, index) => pairAddress(index));
  }
  const statusCounts = () => Object.fromEntries(d1.rows('SELECT status, COUNT(*) AS n FROM goldmine_outcomes GROUP BY status ORDER BY status').map(row => [row.status, row.n]));
  const statusOf = pairAddressValue => d1.rows('SELECT o.status FROM goldmine_outcomes o JOIN goldmine_signals s ON s.id = o.signal_id WHERE s.pair = ?', pairAddressValue)[0].status;

  beforeEach(() => {
    // Discovery finds nothing, so only outcome evaluation reaches the provider.
    feeds.profiles = feeds.boosts = () => Response.json([]);
    requests = [];
    outcomePools = url => {
      const batch = url.split('/').pop().split(',');
      requests.push(batch);
      return Response.json({pairs: batch.map(pool => outcomePool(pool, addresses.tokenA, '1.2'))});
    };
  });

  test('more than 30 due pools are read in deterministic batches of 30 and all settle in their window', async () => {
    const pools = seedDue(45);
    const data = await body(await scan());
    assert.deepEqual(data.tracking.outcomes, {provider: 'ok', observed: 45, unavailable: 0, missed: 0, deferred: 0});
    assert.deepEqual(requests, [pools.slice(0, 30), pools.slice(30)], 'earliest-closing windows first, at most 30 pools per request');
    assert.deepEqual(statusCounts(), {observed: 45});

    // After every window has closed, nothing was left to be marked missed.
    clock.advance(10 * MINUTE);
    assert.equal((await body(await scan())).tracking.outcomes.missed, 0);
    assert.deepEqual(statusCounts(), {observed: 45});
  });

  test('a failed batch leaves only its own outcomes pending, and a later in-window scan settles them', async () => {
    const pools = seedDue(45);
    const healthy = outcomePools;
    outcomePools = url => url.includes(pools[30]) ? new Response('rate limited', {status: 429}) : healthy(url);
    const partial = await body(await scan());
    assert.deepEqual(partial.tracking.outcomes, {provider: 'partial', observed: 30, unavailable: 0, missed: 0, deferred: 0});
    assert.deepEqual(statusCounts(), {observed: 30, pending: 15});
    assert.deepEqual([statusOf(pools[29]), statusOf(pools[30]), statusOf(pools[44])], ['observed', 'pending', 'pending']);
    assert.deepEqual(failures.map(failure => [failure.operation, failure.level]), [['outcome-provider', 'warn'], ['provider', 'warn']]);

    clock.advance(MINUTE);
    outcomePools = healthy;
    requests = [];
    assert.deepEqual((await body(await scan())).tracking.outcomes, {provider: 'ok', observed: 15, unavailable: 0, missed: 0, deferred: 0});
    assert.deepEqual(requests, [pools.slice(30)], 'only the failed batch is requested again');
    assert.deepEqual(statusCounts(), {observed: 45});
  });

  test('every batch failing leaves every outcome pending', async () => {
    seedDue(35);
    outcomePools = () => new Response('down', {status: 503});
    assert.deepEqual((await body(await scan())).tracking.outcomes, {provider: 'unavailable', observed: 0, unavailable: 0, missed: 0, deferred: 0});
    assert.deepEqual(statusCounts(), {pending: 35});
  });

  test('provider requests stay bounded; pools beyond the cap are deferred, not skipped into missed', async () => {
    const pools = seedDue(170);
    const first = await body(await scan());
    assert.equal(requests.length, 5, 'at most five requests per scan');
    assert.ok(requests.every(batch => batch.length <= 30));
    assert.deepEqual(first.tracking.outcomes, {provider: 'ok', observed: 150, unavailable: 0, missed: 0, deferred: 20});
    assert.deepEqual([statusOf(pools[149]), statusOf(pools[150])], ['observed', 'pending'], 'the most urgent windows are read first');

    clock.advance(MINUTE);
    requests = [];
    assert.deepEqual((await body(await scan())).tracking.outcomes, {provider: 'ok', observed: 20, unavailable: 0, missed: 0, deferred: 0});
    assert.deepEqual(requests, [pools.slice(150)]);
    assert.deepEqual(statusCounts(), {observed: 170});
  });
});
