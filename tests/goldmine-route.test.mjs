// /api/goldmine: signed-in scans that score DEX Screener candidates, record signals with the detection
// price, and settle the active daily-snapshot outcomes (d1/d3/d7, lib/goldmine/cadence.ts) only inside their
// windows. DEX Screener is a local fetch double.
import assert from 'node:assert/strict';
import {beforeEach, describe, test} from 'node:test';
import {addresses, body, createD1, failures, installFetch, jsonRequest, runtime, signIn, signOut, startClock} from './helpers/harness.mjs';
import {pair} from './helpers/goldmine-fixtures.mjs';

const {GET, POST} = await import('../app/api/goldmine/route.ts');
const {MODEL_VERSION} = await import('../lib/goldmine/score.ts');
const {ACTIVE_HORIZON_IDS, MAX_SCAN_GAP_MS, MIN_SCAN_GAP_MS, OBSERVATION_GRACE_MS, SCAN_CADENCE_MS} = await import('../lib/goldmine/cadence.ts');
const {contractSafetySummary} = await import('../lib/goldmine/snapshot.ts');
const {reviewEvidence} = await import('../lib/goldmine/review-evidence.ts');
const {RECENT_SIGNALS_READ} = await import('../lib/goldmine/evidence-view.ts');
const {MAX_OUTCOME_BATCHES, MAX_PAIRS_PER_REQUEST} = await import('../lib/goldmine/signals.ts');

// A realistic populated RugCheck report that verifies cleanly (same shape as the Stage 03B provider
// preflight and tests/goldmine-contract-safety.test.mjs's own `report()`), and a rugged variant of it.
function safetyReport(overrides = {}) {
  return {
    token: {mintAuthority: null, freezeAuthority: null, supply: 1_000_000_000, decimals: 6},
    rugged: false,
    totalMarketLiquidity: 250000,
    topHolders: [{pct: 8}, {pct: 5}, {pct: 3}],
    creatorBalance: 10_000_000,
    graphInsidersDetected: 0,
    score_normalised: 5,
    risks: [{name: 'Mutable metadata', level: 'warn', description: 'Token metadata can be changed by the owner'}],
    markets: [{lp: {quoteUSD: 50000, baseUSD: 50000, lpLockedPct: 95}}],
    ...overrides,
  };
}

const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
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

// A scan that settles due outcomes and records nothing new: discovery answers normally but returns no
// pools. The active horizons are days apart, and every multi-day advance crosses a new six-hour signal
// bucket (SIGNAL_BUCKET_MS), so an ordinary follow-up scan would re-record the same tokens and add fresh
// pending outcomes to whatever is being counted. This keeps the signal under test the only one with
// outcomes, without suppressing any part of the settling path.
async function settleOnlyScan() {
  const pairs = feeds.pairs;
  feeds.pairs = () => Response.json([]);
  try { return await body(await scan()); } finally { feeds.pairs = pairs; }
}

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
    // Only the active daily schedule is written: a 1-, 3- and 7-day target, each with the 26h grace window
    // that makes it observable by a once-daily scan. No legacy intraday row is ever created again.
    assert.deepEqual(outcomes().filter(row => row.address === addresses.tokenA).map(row => [row.horizon, row.status, row.due_at - now, row.deadline_at - now]), [
      ['d1', 'pending', DAY, DAY + OBSERVATION_GRACE_MS],
      ['d3', 'pending', 3 * DAY, 3 * DAY + OBSERVATION_GRACE_MS],
      ['d7', 'pending', 7 * DAY, 7 * DAY + OBSERVATION_GRACE_MS],
    ]);
    const [stored] = d1.rows('SELECT snapshot, assessment FROM goldmine_signals WHERE address = ?', addresses.tokenA);
    const {snapshot, reviewEvidence: servedEvidence, ...assessment} = a;
    const storedSnapshot = JSON.parse(stored.snapshot);
    // Stage 09A: the interactive response's review view is exactly what the stored row yields, so a card
    // shown straight after a scan and the same signal read back later from GET can never disagree.
    assert.deepEqual(servedEvidence, reviewEvidence(storedSnapshot, JSON.parse(stored.assessment)));
    // Storage (recordSignals) keeps the full scored snapshot, including raw contractSafety facts, so a
    // later model version can re-score exactly what was observed; only the served response reduces
    // contractSafety to the minimal client-facing shape. Everything else is exactly what was served.
    assert.deepEqual({...storedSnapshot, contractSafety: contractSafetySummary(storedSnapshot.contractSafety)}, snapshot, 'served snapshot matches storage except contractSafety, minimized for the client');
    assert.deepEqual(JSON.parse(stored.assessment), assessment);
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
    assert.equal(outcomes().length, 4 * ACTIVE_HORIZON_IDS.length);
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
    assert.deepEqual([signals().length, outcomes().length], [25, 25 * ACTIVE_HORIZON_IDS.length]);
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
    clock.advance(DAY); // the first active horizon (d1) is now due, whatever discovery does
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

    // A scan a minute short of the 1-day target settles nothing: the drift that makes a daily snapshot land
    // a day late, and the exact case the grace window exists to absorb.
    clock.advance(DAY - MINUTE);
    assert.equal((await settleOnlyScan()).tracking.outcomes.provider, 'not_needed', 'nothing is due before the 24h target');
    assert.deepEqual(status()['d1'], ['pending', null]);

    // The next daily scan is the first qualifying one, and settles d1 only.
    clock.advance(MINUTE);
    assert.deepEqual((await settleOnlyScan()).tracking.outcomes, {provider: 'ok', observed: 2, unavailable: 0, missed: 0, deferred: 0});
    assert.deepEqual(status(), {d1: ['observed', 0.012], d3: ['pending', null], d7: ['pending', null]});

    // A check past d3's deadline (72h + 26h) can never be recorded as the 3-day price: it is missed.
    clock.advance(detected + 3 * DAY + OBSERVATION_GRACE_MS + HOUR - clock.now());
    outcomePools = () => Response.json({pairs: [outcomePool(addresses.pairA, addresses.tokenA, '0.5'), outcomePool(addresses.pairB, addresses.tokenB, '9')]});
    const late = await settleOnlyScan();
    assert.deepEqual([late.tracking.outcomes.missed, late.tracking.outcomes.observed], [2, 0]);
    assert.deepEqual(status()['d3'], ['missed', null]);

    // d7 is still open, and settles at the first scan at or after its 168h target.
    clock.advance(detected + 7 * DAY + 30 * MINUTE - clock.now());
    await settleOnlyScan();
    assert.deepEqual(status()['d7'], ['observed', 0.5]);
    const [row] = outcomes().filter(outcome => outcome.address === addresses.tokenA && outcome.detected_at === detected && outcome.horizon === 'd7');
    assert.equal(row.observed_at, clock.now());
    assert.ok(row.observed_at - detected >= 7 * DAY, 'never observed before its target');
  });

  test('a pool missing from a successful response is unavailable; a provider failure leaves outcomes pending', async () => {
    await scan();
    clock.advance(DAY);
    outcomePools = () => new Response('rate limited', {status: 429});
    const failed = await settleOnlyScan();
    assert.deepEqual(failed.tracking.outcomes, {provider: 'unavailable', observed: 0, unavailable: 0, missed: 0, deferred: 0});
    assert.ok(failures.some(failure => failure.operation === 'outcome-provider' && failure.level === 'warn'));
    // A provider failure leaves the row pending inside its still-open window, for the next scan to retry.
    assert.equal(outcomes().filter(row => row.horizon === 'd1' && row.status === 'pending').length, 2);

    clock.advance(MINUTE);
    outcomePools = () => Response.json({pairs: [outcomePool(addresses.pairA, addresses.tokenA, '0.011'), outcomePool(addresses.pairB, addresses.tokenA, '1'), {chainId: 'ethereum', pairAddress: addresses.pairB, baseToken: {address: addresses.tokenB}, priceUsd: '1'}]});
    assert.deepEqual((await settleOnlyScan()).tracking.outcomes, {provider: 'ok', observed: 1, unavailable: 1, missed: 0, deferred: 0});
    assert.deepEqual(outcomes().filter(row => row.horizon === 'd1').map(row => [row.address, row.status, row.price]),
      [[addresses.tokenA, 'observed', 0.011], [addresses.tokenB, 'unavailable', null]]);
  });

  test('GET lists recent signals with ordered outcomes, returns and per-state statistics', async () => {
    await scan();
    const detected = clock.now();
    clock.advance(DAY);
    await settleOnlyScan();
    const observedAt = clock.now();
    const response = await read();
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = await body(response);
    assert.equal(data.modelVersion, MODEL_VERSION);
    assert.equal(data.evaluationScheduleVersion, 'daily-snapshot-v1');
    assert.deepEqual(data.signals.map(signal => [signal.address, signal.state]), [[addresses.tokenA, 'BREAKOUT'], [addresses.tokenB, 'REJECTED']]);
    const a = data.signals[0];
    assert.deepEqual(a.outcomes.map(outcome => [outcome.horizon, outcome.status, outcome.returnPct]), [['d1', 'observed', 20], ['d3', 'pending', null], ['d7', 'pending', null]]);
    // Each outcome carries the schedule it belongs to and, for the settled one, the real elapsed time -
    // never an implied "this is the 24-hour price".
    const settled = a.outcomes[0];
    assert.deepEqual([settled.horizonLabel, settled.horizonActive, settled.observableUnderCadence, settled.targetHours], ['1-day target', true, true, 24]);
    assert.equal(settled.state, 'observed');
    assert.equal(settled.observedAfterHours, Number(((observedAt - detected) / HOUR).toFixed(2)));
    assert.deepEqual(a.outcomes.slice(1).map(outcome => outcome.state), ['pending', 'pending'], 'the unsettled windows are still genuinely open');
    assert.equal(a.assessment.summary.startsWith('BREAKOUT · score 81/100.'), true);
    assert.deepEqual(data.signals.map(signal => signal.contractSafety.status), ['unavailable', 'unavailable'], 'the dashboard can read contract safety without a second RugCheck call');
    assert.deepEqual(data.stats.filter(row => row.horizon === 'd1').map(row => [row.state, row.pending, row.expiredUnswept, row.observed, row.meanReturnPct, row.positiveShare]), [
      ['BREAKOUT', 0, 0, 1, 20, 1],
      ['REJECTED', 0, 0, 1, -25, 0],
    ]);
    assert.deepEqual(data.stats.filter(row => row.horizon === 'd1').map(row => [row.horizonLabel, row.horizonActive, row.observableUnderCadence, row.targetHours]), [
      ['1-day target', true, true, 24], ['1-day target', true, true, 24],
    ]);
    assert.deepEqual(data.stats.filter(row => row.horizon === 'd7').map(row => [row.state, row.pending, row.meanReturnPct]), [['BREAKOUT', 1, null], ['REJECTED', 1, null]]);
  });

  // --- Stage 06: the cadence block, and expired-unswept rows in the grouped statistic -------------------

  test('GET reports the cadence it was read under, with every known horizon and its observability', async () => {
    const data = await body(await read());
    assert.equal(data.cadence.cronExpression, '0 0 * * *');
    assert.deepEqual([data.cadence.scanCadenceMs, data.cadence.maxScanGapMs, data.cadence.observationGraceMs],
      [SCAN_CADENCE_MS, MAX_SCAN_GAP_MS, OBSERVATION_GRACE_MS]);
    assert.ok(data.cadence.observationGraceBufferMs > 0, 'the grace window must clear the maximum scan gap');
    assert.deepEqual(data.cadence.horizons.map(horizon => [horizon.id, horizon.active, horizon.observableUnderCadence]), [
      ['15m', false, false], ['1h', false, false], ['6h', false, false], ['24h', false, false],
      ['d1', true, true], ['d3', true, true], ['d7', true, true],
    ]);
    assert.equal(data.cadence.minScanGapMs, MIN_SCAN_GAP_MS);
  });

  test('a pending outcome past its deadline is reported as expired-unswept, not live pending, with no write', async () => {
    await scan();
    const before = JSON.stringify(d1.rows('SELECT * FROM goldmine_outcomes'));
    // Move past d1's deadline without ever scanning again, then read.
    clock.advance(DAY + OBSERVATION_GRACE_MS + HOUR);
    const data = await body(await read());
    const outcome = data.signals[0].outcomes.find(entry => entry.horizon === 'd1');
    assert.equal(outcome.status, 'pending', 'storage is untouched');
    assert.equal(outcome.state, 'expired_unswept', 'but it is not reported as work still to come');
    const stat = data.stats.find(row => row.horizon === 'd1' && row.state === 'BREAKOUT');
    assert.deepEqual([stat.pending, stat.expiredUnswept], [0, 1]);
    assert.equal(JSON.stringify(d1.rows('SELECT * FROM goldmine_outcomes')), before, 'opening the dashboard never rewrites a row');
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
    assert.equal(json.includes('RugCheck-authored text'), false, 'provider risk text never reaches the client');
    // Deliberately changed in Stage 09A: the provider *name* is now client-facing as the source label of
    // reviewEvidence's allow-listed facts. The badge shape itself still never carries it.
    assert.equal(JSON.stringify(data.signals[0].contractSafety).includes('rugcheck'), false, 'the badge shape carries no provider name');
  });

  test('reviewEvidence (Stage 09A) carries only allow-listed facts and the stored classification', async () => {
    seedSignal('sig-unsafe-evidence', JSON.stringify({address: addresses.tokenA, pair: addresses.pairA, observedAt: clock.now(), contractSafety: {
      status: 'unsafe', source: 'rugcheck', checkedAt: clock.now() - 60000,
      facts: {mintAuthorityRenounced: false, freezeAuthorityRenounced: true, creatorHoldingsPct: 2, providerRisks: [{name: 'Secret risk name', level: 'danger', description: 'RugCheck-authored text'}], providerScoreNormalized: 3},
      failedChecks: ['Mint authority is still active.'],
    }}));
    const evidence = (await body(await read())).signals[0].reviewEvidence;
    assert.deepEqual(evidence.safety, {status: 'unsafe', reportAt: clock.now() - 60000, unavailableReason: null});
    assert.deepEqual(evidence.hardFailures, ['Mint authority is still active.']);
    const byId = Object.fromEntries(evidence.factors.map(item => [item.id, item]));
    assert.equal(byId.mint_authority.status, 'fails_check');
    assert.equal(byId.creator_holding.value, 2);
    assert.equal(byId.creator_holding.status, 'within_check', 'unsafe lists every failed available check, so an unlisted present fact passed its stored check');
    const json = JSON.stringify(evidence);
    for (const leak of ['Secret risk name', 'RugCheck-authored text', 'providerRisks', 'providerScoreNormalized', '"facts"', 'failedChecks', 'checkedAt']) {
      assert.equal(json.includes(leak), false, leak);
    }
  });

  test('reviewEvidence is withheld when the stored snapshot names a different mint or pool than its row', async () => {
    seedSignal('sig-other-pool', JSON.stringify({address: addresses.tokenA, pair: 'SomeOtherPool', observedAt: clock.now(), liquidityUsd: 1234567,
      contractSafety: {status: 'verified', source: 'rugcheck', checkedAt: clock.now(), facts: {mintAuthorityRenounced: true}}}));
    const evidence = (await body(await read())).signals[0].reviewEvidence;
    assert.equal(evidence.readable, false);
    assert.equal(evidence.safety.status, 'unavailable');
    assert.equal(JSON.stringify(evidence).includes('1234567'), false);
  });

  test('a REJECTED row carries no reviewEvidence (never rendered as a card), keeping the fixed read small', async () => {
    d1.sqlite.prepare('INSERT INTO goldmine_signals (id, address, pair, symbol, model_version, state, score, opportunity, detected_at, detected_price, snapshot, assessment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('sig-rejected', addresses.tokenA, addresses.pairA, 'FIX', MODEL_VERSION, 'REJECTED', 10, 0, clock.now(), 0.01, '{}', '{"summary":"REJECTED."}');
    assert.equal((await body(await read())).signals[0].reviewEvidence, null);
  });

  test(`GET returns at most RECENT_SIGNALS_READ (${RECENT_SIGNALS_READ}) signals, the window the near-miss copy names`, async () => {
    const insert = d1.sqlite.prepare('INSERT INTO goldmine_signals (id, address, pair, symbol, model_version, state, score, opportunity, detected_at, detected_price, snapshot, assessment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < RECENT_SIGNALS_READ + 7; i++) insert.run(`sig-${i}`, addresses.tokenA, addresses.pairA, 'FIX', MODEL_VERSION, 'BUILDING', 50, 0, clock.now() - i * 60000, 0.01, '{}', '{"summary":"BUILDING."}');
    const data = await body(await read());
    assert.equal(data.signals.length, RECENT_SIGNALS_READ);
    assert.equal(data.signals[0].id, 'sig-0', 'newest first');
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

describe('POST contractSafety: candidates[].snapshot.contractSafety matches GET\'s minimal client shape', () => {
  test('verified: minimal {status} only, nothing from facts, source, checkedAt or provider score/risks', async () => {
    feeds.safety = () => Response.json(safetyReport());
    const data = await body(await scan());
    const a = data.candidates.find(c => c.address === addresses.tokenA);
    assert.deepEqual(a.snapshot.contractSafety, {status: 'verified'});
    assert.deepEqual(Object.keys(a.snapshot.contractSafety), ['status']);
    // Scope the leak check to the contractSafety value itself, not the whole payload: the assessment's
    // own scoring evidence legitimately names "rugcheck" as the check performed (lib/goldmine/score.ts) -
    // that is unrelated to this fix, which is only about candidates[].snapshot.contractSafety's shape.
    const json = JSON.stringify(a.snapshot.contractSafety);
    for (const leak of ['facts', 'providerRisks', 'providerScoreNormalized', 'checkedAt', 'mintAuthorityRenounced', 'source', 'rugcheck']) {
      assert.equal(json.includes(leak), false, leak);
    }
  });

  test('unsafe: minimal {status, reason} built only from our own check messages, never RugCheck facts or provider risk text', async () => {
    feeds.safety = () => Response.json(safetyReport({rugged: true}));
    const data = await body(await scan());
    const a = data.candidates.find(c => c.address === addresses.tokenA);
    assert.deepEqual(a.snapshot.contractSafety.status, 'unsafe');
    assert.ok(a.snapshot.contractSafety.reason.includes('recorded this contract as rugged'));
    assert.deepEqual(Object.keys(a.snapshot.contractSafety).sort(), ['reason', 'status']);
    const json = JSON.stringify(a.snapshot.contractSafety);
    for (const leak of ['facts', 'providerRisks', 'providerScoreNormalized', 'checkedAt', 'mintAuthorityRenounced', 'source', 'rugcheck']) {
      assert.equal(json.includes(leak), false, leak);
    }
  });

  test('unavailable: the default when RugCheck has no usable facts yet (a REJECTED candidate never even reaches it)', async () => {
    // The default beforeEach `feeds.safety` (an incomplete report) already covers the actionable
    // candidate; token B is REJECTED (thin_liquidity) and so never sent to RugCheck at all.
    const data = await body(await scan());
    const [a, b] = data.candidates;
    assert.deepEqual(a.snapshot.contractSafety, {status: 'unavailable'});
    assert.deepEqual(b.snapshot.contractSafety, {status: 'unavailable'});
    assert.deepEqual(Object.keys(a.snapshot.contractSafety), ['status']);
  });

  test('GET and POST agree on the minimal contractSafety shape for the same recorded signal', async () => {
    feeds.safety = () => Response.json(safetyReport());
    const posted = await body(await scan());
    const candidate = posted.candidates.find(c => c.address === addresses.tokenA);
    const got = await body(await read());
    const signal = got.signals.find(s => s.address === addresses.tokenA);
    assert.deepEqual(signal.contractSafety, candidate.snapshot.contractSafety);
    assert.deepEqual(candidate.snapshot.contractSafety, {status: 'verified'});
  });

  test('the shared reducer fails closed on missing/malformed/legacy contractSafety values without crashing, the same defense POST relies on', () => {
    // Never recognizable as verified or unsafe: always the safe 'unavailable' default, never a crash.
    for (const malformed of [undefined, null, {}, {status: 'pending-review'}, '{not json', 42, []]) {
      assert.deepEqual(contractSafetySummary(malformed), {status: 'unavailable'}, JSON.stringify(malformed));
    }
    // Recognizable as 'unsafe' but with a malformed/missing failedChecks list: still status 'unsafe' (never
    // silently downgraded to safe), with a generic fallback reason instead of crashing on the bad shape.
    for (const malformed of [{status: 'unsafe', failedChecks: 'not-an-array'}, {status: 'unsafe', failedChecks: [1, 2]}, {status: 'unsafe'}]) {
      assert.deepEqual(contractSafetySummary(malformed), {status: 'unsafe', reason: 'Contract safety checks failed.'}, JSON.stringify(malformed));
    }
    assert.deepEqual(contractSafetySummary({status: 'unsafe', failedChecks: ['Mint authority is still active.']}), {status: 'unsafe', reason: 'Mint authority is still active.'});
  });

  test('no ContractSafety-only field leaks anywhere in the full serialized POST body, not just inside snapshot.contractSafety', async () => {
    // Matched as JSON object keys ("key":), not substrings: snapshot.source ('dexscreener') and
    // assessment evidence text naming the provider ("rugcheck") are legitimate and unrelated to this
    // check, which targets only field names unique to the stored ContractSafety/ContractSafetyFacts
    // shape (lib/goldmine/snapshot.ts). A future change that spreads or nests the raw object anywhere in
    // the response - not only into candidates[].snapshot.contractSafety - would be caught here.
    feeds.safety = () => Response.json(safetyReport({rugged: true}));
    const raw = await (await scan()).text();
    for (const key of ['facts', 'providerRisks', 'providerScoreNormalized', 'checkedAt', 'failedChecks', 'mintAuthorityRenounced', 'freezeAuthorityRenounced', 'lpLockedPct', 'totalMarketLiquidityUsd', 'topHolderPct', 'topHoldersPct', 'creatorHoldingsPct', 'insiderNetworksDetected', 'rugged']) {
      assert.equal(raw.includes(`"${key}"`), false, key);
    }
  });
});

describe('outcome batches', () => {
  const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const pairAddress = index => 'Pair' + BASE58[Math.floor(index / BASE58.length)] + BASE58[index % BASE58.length] + 'B'.repeat(38);
  let requests;

  // `count` signals detected 16 minutes ago, one pool each, whose 15m outcomes are due now. Signal i was
  // detected 100 ms earlier than signal i+1, so its window closes first; the spacing is small enough that
  // even the capacity-sized seeds (1,200+ pools) all still have an open 5-minute window at scan time.
  function seedDue(count) {
    const now = clock.now();
    for (let index = 0; index < count; index++) {
      const detected = now - 16 * MINUTE - (count - index) * 100;
      const id = `batch-signal-${String(index).padStart(4, '0')}`;
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
    const cap = MAX_OUTCOME_BATCHES * MAX_PAIRS_PER_REQUEST;
    const pools = seedDue(cap + 20);
    const first = await body(await scan());
    assert.equal(requests.length, MAX_OUTCOME_BATCHES, 'at most MAX_OUTCOME_BATCHES requests per scan');
    assert.ok(requests.every(batch => batch.length <= 30));
    assert.deepEqual(first.tracking.outcomes, {provider: 'ok', observed: cap, unavailable: 0, missed: 0, deferred: 20});
    assert.deepEqual([statusOf(pools[cap - 1]), statusOf(pools[cap])], ['observed', 'pending'], 'the most urgent windows are read first');

    clock.advance(MINUTE);
    requests = [];
    assert.deepEqual((await body(await scan())).tracking.outcomes, {provider: 'ok', observed: 20, unavailable: 0, missed: 0, deferred: 0});
    assert.deepEqual(requests, [pools.slice(cap)]);
    assert.deepEqual(statusCounts(), {observed: cap + 20});
  });

  test('one daily run settles a 15-minute detector\'s worth of distinct pools: 3 horizons x 400 distinct pairs/day fits in one run', async () => {
    // 400 distinct pairs detected per day is the design point (docs/capacity-96-per-day.md): each is due at
    // d1, d3 and d7, but on any one day only one of those horizons is due per pair, so a steady state has
    // about 3 x 400 = 1,200 pools due per daily run - exactly MAX_OUTCOME_BATCHES x MAX_PAIRS_PER_REQUEST.
    assert.equal(MAX_OUTCOME_BATCHES * MAX_PAIRS_PER_REQUEST, 3 * 400);
    seedDue(1200);
    const run = (await body(await scan())).tracking.outcomes;
    assert.deepEqual(run, {provider: 'ok', observed: 1200, unavailable: 0, missed: 0, deferred: 0});
  });
});

// GET's `latest` (lib/goldmine/signals.ts readLatestBatch) is what makes an unattended scheduled scan
// visible: it reports the most recent recorded batch from storage, so the dashboard no longer depends on
// the viewer having pressed "Scan now" in this session to show anything at all.
describe('GET latest: the most recent recorded batch, from storage, independent of any session scan', () => {
  // Writes one signal row directly, so a batch's exact composition (and rows that recordSignals itself
  // would never produce) can be set up without driving a whole scan.
  function seedSignal(id, {state = 'BREAKOUT', opportunity = 0, detectedAt = clock.now()} = {}) {
    d1.sqlite.prepare('INSERT INTO goldmine_signals (id, address, pair, symbol, model_version, state, score, opportunity, detected_at, detected_price, snapshot, assessment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, addresses.tokenA, addresses.pairA, 'FIX', MODEL_VERSION, state, 81, opportunity, detectedAt, 0.01, '{}', '{"summary":"x"}');
  }

  test('an empty history reports null, not a zeroed batch that would read as "a scan found nothing"', async () => {
    assert.equal((await body(await read())).latest, null);
  });

  test('a real scan is reported without the caller having scanned in this session', async () => {
    const scanned = await body(await scan());
    const latest = (await body(await read())).latest;
    assert.equal(latest.detectedAt, scanned.asOf, 'the batch carries the scan\'s own detection time');
    assert.equal(latest.signalCount, signals().length);
    assert.equal(latest.signalCount, latest.byState.reduce((total, entry) => total + entry.count, 0), 'the breakdown must account for every counted signal');
  });

  test('only the newest batch is reported, never a total across every scan ever recorded', async () => {
    seedSignal('old-1', {state: 'EARLY', detectedAt: clock.now() - 48 * HOUR});
    seedSignal('old-2', {state: 'REJECTED', detectedAt: clock.now() - 48 * HOUR});
    const newest = clock.now();
    seedSignal('new-1', {state: 'BUILDING', detectedAt: newest});
    const latest = (await body(await read())).latest;
    assert.equal(latest.detectedAt, new Date(newest).toISOString());
    assert.equal(latest.signalCount, 1);
    assert.deepEqual(latest.byState, [{state: 'BUILDING', count: 1}]);
  });

  test('opportunities within the batch are counted, and a batch with none is still a reported batch', async () => {
    const detectedAt = clock.now();
    seedSignal('a', {state: 'BREAKOUT', opportunity: 1, detectedAt});
    seedSignal('b', {state: 'BREAKOUT', opportunity: 1, detectedAt});
    seedSignal('c', {state: 'REJECTED', opportunity: 0, detectedAt});
    const withOpportunities = (await body(await read())).latest;
    assert.deepEqual([withOpportunities.signalCount, withOpportunities.opportunityCount], [3, 2]);

    clock.advance(HOUR);
    seedSignal('d', {state: 'REJECTED', opportunity: 0, detectedAt: clock.now()});
    const withoutOpportunities = (await body(await read())).latest;
    assert.deepEqual([withoutOpportunities.signalCount, withoutOpportunities.opportunityCount], [1, 0],
      'a batch that found nothing actionable is still reported, so it is distinguishable from no scan at all');
  });

  test('states are listed in the model\'s own order, and an unknown stored state is kept rather than dropped', async () => {
    const detectedAt = clock.now();
    seedSignal('r', {state: 'REJECTED', detectedAt});
    seedSignal('e', {state: 'EARLY', detectedAt});
    seedSignal('z', {state: 'LEGACY_STATE', detectedAt});
    const latest = (await body(await read())).latest;
    assert.deepEqual(latest.byState, [{state: 'EARLY', count: 1}, {state: 'REJECTED', count: 1}, {state: 'LEGACY_STATE', count: 1}]);
    assert.equal(latest.signalCount, 3, 'an unexpected state must never make the counts stop adding up');
  });

  test('is read-only and never reaches a provider', async () => {
    seedSignal('only', {});
    d1.queries.length = 0;
    calls.length = 0;
    assert.notEqual((await body(await read())).latest, null);
    assert.equal(calls.length, 0, 'no provider request');
    assert.ok(d1.queries.every(query => /^\s*SELECT/i.test(query)), 'every statement this read issues is a SELECT');
  });
});
