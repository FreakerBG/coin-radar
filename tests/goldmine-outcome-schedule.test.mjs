// Stage 06 outcome scheduling against a real (in-memory sqlite) D1: what recordSignals writes, what
// evaluateOutcomes settles and when, and what the read paths derive from stored rows without writing.
// DEX Screener's pairs endpoint is a local fetch double; nothing here reaches a network, and every
// "no mutation" claim is checked against the raw rows.
//
// The pure arithmetic of the observability proof lives in tests/goldmine-cadence.test.mjs. This file
// checks that the real SQL agrees with it.
import assert from 'node:assert/strict';
import {beforeEach, describe, test} from 'node:test';
import {addresses, createD1, installFetch, runtime, startClock} from './helpers/harness.mjs';
import {pair} from './helpers/goldmine-fixtures.mjs';

const {
  evaluateOutcomes, isValidStoredOutcomeRow, OUTCOME_STATUSES, readAllSignalsWithOutcomes, readSignalTotals,
  readTracking, recordSignals,
} = await import('../lib/goldmine/signals.ts');
const {
  ACTIVE_HORIZONS, ACTIVE_HORIZON_IDS, KNOWN_HORIZON_IDS, LEGACY_HORIZON_IDS, MAX_SCAN_GAP_MS,
  MIN_SCAN_GAP_MS, OBSERVATION_GRACE_MS, SCAN_CADENCE_MS, horizonById, latestObservableAgeMs,
} = await import('../lib/goldmine/cadence.ts');
const {MODEL_VERSION, scoreCandidate} = await import('../lib/goldmine/score.ts');
const {snapshotFromPair} = await import('../lib/goldmine/snapshot.ts');
const {denominatorSplit, performanceReport} = await import('../lib/goldmine/backtest.ts');

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
let d1, clock, poolPrice;

const outcomeRows = () => d1.rows('SELECT signal_id, horizon, status, due_at, deadline_at, observed_at, price FROM goldmine_outcomes ORDER BY due_at, horizon');
const rawSnapshot = () => JSON.stringify([d1.rows('SELECT * FROM goldmine_signals'), d1.rows('SELECT * FROM goldmine_outcomes')]);

// One scored candidate, recorded at `detectedAt` exactly as a scan would record it.
async function record(detectedAt, overrides = {}) {
  const snapshot = snapshotFromPair(pair(overrides), detectedAt);
  const assessment = scoreCandidate(snapshot);
  return recordSignals(d1, [{snapshot, assessment}], detectedAt);
}

beforeEach(() => {
  clock = startClock();
  d1 = createD1();
  runtime.env.DB = d1;
  poolPrice = '0.012';
  installFetch(url => {
    if (url.startsWith('https://api.dexscreener.com/latest/dex/pairs/solana/')) {
      return Response.json({pairs: [{chainId: 'solana', pairAddress: addresses.pairA, baseToken: {address: addresses.tokenA}, priceUsd: poolPrice, liquidity: {usd: 140000}}]});
    }
    throw new Error('Unexpected request ' + url);
  });
});

describe('recordSignals writes only the active schedule', () => {
  // Requirement 11: a new signal receives exactly the active horizons and no legacy row.
  test('a new signal gets one row per active horizon, and no legacy horizon row at all', async () => {
    const detectedAt = clock.now();
    assert.equal(await record(detectedAt), 1);
    const rows = outcomeRows();
    assert.deepEqual(rows.map(row => row.horizon), [...ACTIVE_HORIZON_IDS]);
    for (const id of LEGACY_HORIZON_IDS) {
      assert.equal(rows.some(row => row.horizon === id), false, `a new signal must never be given the legacy ${id} horizon`);
    }
  });

  test('due_at is the target age and deadline_at is the target plus the 26h grace window', async () => {
    const detectedAt = clock.now();
    await record(detectedAt);
    assert.deepEqual(outcomeRows().map(row => [row.horizon, row.due_at - detectedAt, row.deadline_at - row.due_at]), [
      ['d1', DAY, OBSERVATION_GRACE_MS],
      ['d3', 3 * DAY, OBSERVATION_GRACE_MS],
      ['d7', 7 * DAY, OBSERVATION_GRACE_MS],
    ]);
  });

  test('every written row starts pending and carries no observation', async () => {
    await record(clock.now());
    for (const row of outcomeRows()) {
      assert.deepEqual([row.status, row.observed_at, row.price], ['pending', null, null]);
    }
  });
});

describe('settling: only inside the window, at the first qualifying scan', () => {
  // Requirements 3, 4 and 5, driven through the real evaluateOutcomes SQL.
  test('a scan slightly before the target does not settle the outcome', async () => {
    const detectedAt = clock.now();
    await record(detectedAt);
    clock.advance(DAY - MINUTE);
    const run = await evaluateOutcomes(d1, clock.now());
    assert.deepEqual(run, {provider: 'not_needed', observed: 0, unavailable: 0, missed: 0, deferred: 0},
      'nothing is due one minute before the 24h target, so no provider request is made at all');
    assert.equal(outcomeRows().find(row => row.horizon === 'd1').status, 'pending');
  });

  test('a scan exactly at the target settles it', async () => {
    const detectedAt = clock.now();
    await record(detectedAt);
    clock.advance(DAY);
    const run = await evaluateOutcomes(d1, clock.now());
    assert.equal(run.observed, 1);
    const row = outcomeRows().find(row => row.horizon === 'd1');
    assert.deepEqual([row.status, row.price, row.observed_at - detectedAt], ['observed', 0.012, DAY]);
  });

  test('the first qualifying scan after the target settles it, and a later scan never overwrites it', async () => {
    const detectedAt = clock.now();
    await record(detectedAt);
    // A scan one minute short of the target leaves it pending (the phase that makes a daily snapshot land a
    // day late), and the next daily scan settles it.
    clock.advance(SCAN_CADENCE_MS - MINUTE);
    await evaluateOutcomes(d1, clock.now());
    assert.equal(outcomeRows().find(row => row.horizon === 'd1').status, 'pending');

    clock.advance(SCAN_CADENCE_MS);
    poolPrice = '0.02';
    await evaluateOutcomes(d1, clock.now());
    const settled = outcomeRows().find(row => row.horizon === 'd1');
    assert.equal(settled.status, 'observed');
    assert.equal(settled.price, 0.02);
    const elapsed = settled.observed_at - detectedAt;
    assert.ok(elapsed > DAY, `the observation is legitimately later than the 24h target (${elapsed}ms)`);
    assert.ok(elapsed <= latestObservableAgeMs(horizonById('d1')), 'and still inside the deadline');

    // A third scan must not re-observe an already-settled row at a new price.
    clock.advance(SCAN_CADENCE_MS);
    poolPrice = '0.5';
    await evaluateOutcomes(d1, clock.now());
    const again = outcomeRows().find(row => row.horizon === 'd1');
    assert.deepEqual([again.price, again.observed_at], [settled.price, settled.observed_at], 'a settled outcome is evaluated once, never re-priced later');
  });

  test('a qualifying scan near the maximum supported gap still settles it', async () => {
    const detectedAt = clock.now();
    await record(detectedAt);
    // The worst case the declared scheduler can produce: the scan before the target is as early as allowed,
    // and the one after it as late as allowed.
    clock.advance(MIN_SCAN_GAP_MS);
    await evaluateOutcomes(d1, clock.now());
    assert.equal(outcomeRows().find(row => row.horizon === 'd1').status, 'pending', 'an early scan before the target does not qualify');

    clock.advance(MAX_SCAN_GAP_MS);
    const run = await evaluateOutcomes(d1, clock.now());
    assert.equal(run.observed, 1, 'a scan a full maximum-gap later is still inside the 26h grace window');
    assert.equal(run.missed, 0, 'and the row was never swept to missed on the way');
    const row = outcomeRows().find(row => row.horizon === 'd1');
    assert.equal(row.status, 'observed');
    assert.ok(row.observed_at - detectedAt <= latestObservableAgeMs(horizonById('d1')));
  });

  test('a gap wider than the declared maximum sweeps the outcome to missed, never back-fills a later price', async () => {
    const detectedAt = clock.now();
    await record(detectedAt);
    clock.advance(latestObservableAgeMs(horizonById('d1')) + MINUTE);
    const run = await evaluateOutcomes(d1, clock.now());
    assert.equal(run.missed, 1);
    const row = outcomeRows().find(row => row.horizon === 'd1');
    assert.deepEqual([row.status, row.price, row.observed_at], ['missed', null, null], 'a late price is never recorded as the horizon\'s price');
    assert.ok(detectedAt < row.due_at);
  });

  test('a realistic daily schedule settles all three active horizons, each after its own target', async () => {
    const detectedAt = clock.now();
    await record(detectedAt);
    // Eight daily scans, each drifting a little, starting from detection.
    for (let day = 1; day <= 8; day++) {
      const drift = (day % 3 - 1) * 20 * MINUTE; // -20min, 0, +20min, repeating
      clock.advance(SCAN_CADENCE_MS + drift - (day === 1 ? 0 : 0));
      await evaluateOutcomes(d1, clock.now());
    }
    const rows = outcomeRows();
    assert.deepEqual(rows.map(row => [row.horizon, row.status]), [['d1', 'observed'], ['d3', 'observed'], ['d7', 'observed']]);
    for (const row of rows) {
      const horizon = horizonById(row.horizon);
      const elapsed = row.observed_at - detectedAt;
      assert.ok(elapsed >= horizon.after, `${row.horizon} must not be observed before its target`);
      assert.ok(elapsed <= latestObservableAgeMs(horizon), `${row.horizon} must not be observed past its deadline`);
    }
  });
});

describe('actual elapsed observation duration is reported, never assumed', () => {
  // Requirement 6.
  test('readTracking reports the real hours between detection and observation', async () => {
    const detectedAt = clock.now();
    await record(detectedAt);
    clock.advance(SCAN_CADENCE_MS - MINUTE);
    await evaluateOutcomes(d1, clock.now()); // too early: still pending
    clock.advance(SCAN_CADENCE_MS);
    await evaluateOutcomes(d1, clock.now()); // settles d1, about 48h after detection
    const observedAt = clock.now();

    const tracking = await readTracking(d1, clock.now());
    const d1Outcome = tracking.signals[0].outcomes.find(outcome => outcome.horizon === 'd1');
    assert.equal(d1Outcome.status, 'observed');
    assert.equal(d1Outcome.targetHours, 24, 'the target is 24 hours');
    assert.equal(d1Outcome.observedAfterHours, Number(((observedAt - detectedAt) / HOUR).toFixed(2)));
    assert.ok(d1Outcome.observedAfterHours > 24, `the real elapsed (${d1Outcome.observedAfterHours}h) is honestly later than the target`);
    assert.equal(d1Outcome.observedAt, new Date(observedAt).toISOString());
    assert.equal(d1Outcome.horizonLabel, '1-day target');
  });

  test('performanceReport pairs each return with the elapsed time of the same observation', async () => {
    const detectedAt = clock.now();
    await record(detectedAt);
    clock.advance(DAY + 3 * HOUR);
    await evaluateOutcomes(d1, clock.now());
    const {signals, outcomes} = await readAllSignalsWithOutcomes(d1);
    const buckets = performanceReport(signals, outcomes, clock.now());
    const bucket = buckets.find(entry => entry.horizon === 'd1');
    assert.equal(bucket.returnsPct.count, 1);
    assert.equal(bucket.observedAfterHours.count, 1, 'one return, one elapsed measurement - the same sample');
    assert.equal(bucket.observedAfterHours.mean, 27);
    assert.deepEqual([bucket.horizonActive, bucket.observableUnderCadence, bucket.targetHours], [true, true, 24]);
  });

  test('a pending or missed outcome contributes no elapsed measurement, never a zero', async () => {
    const detectedAt = clock.now();
    await record(detectedAt);
    const {signals, outcomes} = await readAllSignalsWithOutcomes(d1);
    for (const bucket of performanceReport(signals, outcomes, detectedAt)) {
      assert.deepEqual([bucket.returnsPct.count, bucket.observedAfterHours.count], [0, 0]);
      assert.equal(bucket.observedAfterHours.mean, null, 'no observation means no mean, never 0h');
    }
  });
});

describe('expired-unswept rows are never live pending, and never rewritten by a read', () => {
  // Requirement 7.
  test('a pending row past its deadline is excluded from live pending counts without any database write', async () => {
    const detectedAt = clock.now();
    await record(detectedAt);
    const before = rawSnapshot();
    // Read at a moment past the d1 deadline, without ever running a scan: the row is still stored as
    // 'pending', and must not be reported as live pending work.
    const readAt = detectedAt + latestObservableAgeMs(horizonById('d1')) + HOUR;
    d1.queries.length = 0; // only the read paths below are under test, not recordSignals' own writes

    const {signals, outcomes} = await readAllSignalsWithOutcomes(d1);
    const buckets = performanceReport(signals, outcomes, readAt);
    const d1Bucket = buckets.find(entry => entry.horizon === 'd1');
    assert.deepEqual(d1Bucket.coverage, {pending: 0, expiredUnswept: 1, observed: 0, unavailable: 0, missed: 0});
    // d3 and d7 are still genuinely inside their windows at that instant.
    assert.deepEqual(buckets.find(entry => entry.horizon === 'd3').coverage, {pending: 1, expiredUnswept: 0, observed: 0, unavailable: 0, missed: 0});

    const tracking = await readTracking(d1, readAt);
    const outcome = tracking.signals[0].outcomes.find(entry => entry.horizon === 'd1');
    assert.equal(outcome.status, 'pending', 'the stored status is untouched');
    assert.equal(outcome.state, 'expired_unswept', 'but the derived state says the window has closed');
    const stat = tracking.stats.find(entry => entry.horizon === 'd1');
    assert.deepEqual([stat.pending, stat.expiredUnswept], [0, 1], 'the grouped statistic makes the same distinction');

    assert.equal(rawSnapshot(), before, 'reading the dashboard must not write to storage');
    assert.equal(d1.queries.some(sql => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql)), false, 'the read path issues no write statement');
  });

  test('a row exactly at its deadline is still live pending, matching what a scan would settle', async () => {
    const detectedAt = clock.now();
    await record(detectedAt);
    const deadline = detectedAt + latestObservableAgeMs(horizonById('d1'));
    const tracking = await readTracking(d1, deadline);
    assert.equal(tracking.signals[0].outcomes.find(entry => entry.horizon === 'd1').state, 'pending');
    // ...and a scan at that same instant does settle it, so the derivation and the sweep agree.
    clock.advance(deadline - clock.now());
    assert.equal((await evaluateOutcomes(d1, clock.now())).observed, 1);
  });

  // A single row per (state, horizon) group cannot distinguish a correct GROUP BY from one that merged the
  // two pending kinds together, because a merged group of one is still labelled correctly. This is the case
  // that can: two signals in the same state, same horizon, whose d1 windows close at different times, read
  // at an instant between the two deadlines. The grouped statistic must split them 1/1, and must agree with
  // the per-row derivation over the same rows.
  test('live pending and expired-unswept rows in the SAME state/horizon group are split, never merged', async () => {
    const older = clock.now();
    await record(older, {pairCreatedAt: older - 48 * HOUR});
    // A second signal of the same state and horizon, detected a day later, so its d1 window closes a day
    // after the first one's. A different token/pair, so it is a separate signal rather than a bucket repeat.
    const newer = older + DAY;
    await record(newer, {pairAddress: addresses.pairB, baseToken: {address: addresses.tokenB}, pairCreatedAt: newer - 48 * HOUR});
    // Between the two d1 deadlines: the older signal's window has closed, the newer one's is still open.
    const readAt = older + latestObservableAgeMs(horizonById('d1')) + HOUR;
    assert.ok(readAt > older + latestObservableAgeMs(horizonById('d1')), 'the older window must be closed');
    assert.ok(readAt < newer + latestObservableAgeMs(horizonById('d1')), 'the newer window must still be open');

    const before = rawSnapshot();
    const tracking = await readTracking(d1, readAt);
    const d1Stats = tracking.stats.filter(entry => entry.horizon === 'd1');
    assert.equal(d1Stats.length, 1, 'both signals share one state, so they share one grouped row');
    assert.deepEqual([d1Stats[0].pending, d1Stats[0].expiredUnswept], [1, 1],
      'one window is still open and one has closed: the grouped statistic must not collapse them into a single status');
    // The grouped counts must reconcile with the per-row derived states over exactly the same rows.
    const perRow = tracking.signals.flatMap(signal => signal.outcomes.filter(entry => entry.horizon === 'd1')).map(entry => entry.state);
    assert.deepEqual(perRow.filter(state => state === 'pending').length, d1Stats[0].pending);
    assert.deepEqual(perRow.filter(state => state === 'expired_unswept').length, d1Stats[0].expiredUnswept);
    assert.equal(rawSnapshot(), before, 'and none of this writes to storage');
  });

  test('once a scan sweeps it, the row is missed rather than expired-unswept', async () => {
    const detectedAt = clock.now();
    await record(detectedAt);
    clock.advance(latestObservableAgeMs(horizonById('d1')) + MINUTE);
    await evaluateOutcomes(d1, clock.now());
    const {signals, outcomes} = await readAllSignalsWithOutcomes(d1);
    const bucket = performanceReport(signals, outcomes, clock.now()).find(entry => entry.horizon === 'd1');
    assert.deepEqual(bucket.coverage, {pending: 0, expiredUnswept: 0, observed: 0, unavailable: 0, missed: 1});
  });
});

describe('legacy horizon rows stay valid and visible', () => {
  // Requirements 8, 10 and 12.
  const legacyRow = (overrides = {}) => ({horizon: '15m', status: 'pending', due_at: 1000, deadline_at: 2000, observed_at: null, price: null, liquidity: null, ...overrides});

  test('every legacy id validates, and so does every new active id', () => {
    for (const horizon of KNOWN_HORIZON_IDS) {
      assert.equal(isValidStoredOutcomeRow(legacyRow({horizon})), true, `${horizon} must validate`);
    }
  });

  test('an unknown horizon id, including the confusable 1d/3d/7d spellings, is still rejected', () => {
    for (const horizon of ['1d', '3d', '7d', '12h', 'D1', 'bogus']) {
      assert.equal(isValidStoredOutcomeRow(legacyRow({horizon})), false, `${horizon} must not validate`);
    }
  });

  test('expired_unswept is not a storable status', () => {
    assert.deepEqual([...OUTCOME_STATUSES], ['pending', 'observed', 'unavailable', 'missed']);
    assert.equal(isValidStoredOutcomeRow(legacyRow({status: 'expired_unswept'})), false,
      'a derived state must never be accepted as a stored one');
  });

  test('a deadline before its own due_at is corruption and is rejected', () => {
    assert.equal(isValidStoredOutcomeRow(legacyRow({due_at: 2000, deadline_at: 1999})), false);
    assert.equal(isValidStoredOutcomeRow(legacyRow({due_at: 2000, deadline_at: 2000})), true, 'a zero-width window is not what recordSignals writes, but it is not corruption either');
    assert.equal(isValidStoredOutcomeRow(legacyRow({deadline_at: Number.NaN})), false);
  });

  // Requirement 10: the current production shape - 348 legacy outcome rows across the four legacy
  // horizons - must yield zero malformed outcomes.
  test('a production-shaped fixture of 348 legacy outcome rows yields zero malformed outcomes', async () => {
    const base = clock.now();
    // 87 signals x 4 legacy horizons = 348 outcome rows, each written exactly as the legacy schedule wrote
    // them: due_at = detected + after, deadline_at = due_at + window, with a realistic mix of the statuses
    // a once-daily cadence actually produced (mostly missed on the intraday horizons).
    const LEGACY = LEGACY_HORIZON_IDS.map(id => horizonById(id));
    const signalCount = 348 / LEGACY.length;
    assert.equal(signalCount, 87);
    for (let index = 0; index < signalCount; index++) {
      const detectedAt = base - (signalCount - index) * DAY;
      const snapshot = snapshotFromPair(pair({pairCreatedAt: detectedAt - 48 * HOUR}), detectedAt);
      const assessment = {...scoreCandidate(snapshot), modelVersion: MODEL_VERSION};
      const id = `legacy-${String(index).padStart(3, '0')}`;
      d1.sqlite.prepare('INSERT INTO goldmine_signals (id, address, pair, symbol, model_version, state, score, opportunity, detected_at, detected_price, snapshot, assessment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, snapshot.address, snapshot.pair, snapshot.symbol, MODEL_VERSION, assessment.state, assessment.score, assessment.opportunity ? 1 : 0, detectedAt, snapshot.priceUsd, JSON.stringify(snapshot), JSON.stringify(assessment));
      for (const [position, horizon] of LEGACY.entries()) {
        const dueAt = detectedAt + horizon.after;
        const deadlineAt = dueAt + horizon.window;
        // The realistic legacy distribution: the intraday horizons almost always missed their window, the
        // 24h one sometimes settled, and a handful were unavailable or left pending by a provider failure.
        const status = horizon.id === '24h'
          ? (index % 3 === 0 ? 'observed' : index % 7 === 0 ? 'unavailable' : 'missed')
          : (index % 11 === 0 && position === 0 ? 'observed' : 'missed');
        const observedAt = status === 'observed' || status === 'unavailable' ? dueAt + MINUTE : null;
        const price = status === 'observed' ? snapshot.priceUsd * 1.05 : null;
        const liquidity = status === 'observed' ? 120000 : null;
        d1.sqlite.prepare('INSERT INTO goldmine_outcomes (signal_id, horizon, due_at, deadline_at, status, observed_at, price, liquidity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, horizon.id, dueAt, deadlineAt, status, observedAt, price, liquidity);
      }
    }
    assert.equal(d1.rows('SELECT COUNT(*) AS n FROM goldmine_outcomes')[0].n, 348);

    const result = await readAllSignalsWithOutcomes(d1);
    assert.equal(result.skippedMalformedOutcomes, 0, 'every stored legacy outcome row must remain valid');
    assert.equal(result.skippedMalformedSignals, 0);
    assert.equal(result.outcomes.length, 348, 'and every one of them must remain visible');
    assert.equal(result.signals.length, 87);
    assert.equal(result.truncated, false);

    // Requirement 12: they are still visible in coverage reporting, attributed to the legacy schedule and
    // marked unobservable on this cadence.
    const buckets = performanceReport(result.signals, result.outcomes, clock.now());
    const legacyBuckets = buckets.filter(bucket => LEGACY_HORIZON_IDS.includes(bucket.horizon));
    assert.ok(legacyBuckets.length > 0, 'legacy rows must still produce reported buckets');
    const counted = buckets.reduce((total, bucket) =>
      total + bucket.coverage.pending + bucket.coverage.expiredUnswept + bucket.coverage.observed + bucket.coverage.unavailable + bucket.coverage.missed, 0);
    assert.equal(counted, 348, 'every stored outcome is counted in exactly one coverage slot');
    for (const bucket of legacyBuckets) {
      assert.equal(bucket.horizonActive, false);
      assert.equal(bucket.observableUnderCadence, false, `${bucket.horizon} must be reported as unobservable on this cadence`);
      assert.equal(bucket.horizonSchedule, 'intraday-v0');
    }
  });

  test('the scoring model version is untouched by this stage', () => {
    assert.equal(MODEL_VERSION, 'momentum-v2.1.0');
  });
});

describe('control group and strategy have separate denominators', () => {
  // Requirement 13.
  test('REJECTED observations and opportunity observations are counted apart and never summed', async () => {
    const base = clock.now();
    // Two populations: a thin, REJECTED token (the control) and a BREAKOUT that clears every gate.
    const rows = [
      {id: 'ctl-1', state: 'REJECTED', opportunity: 0},
      {id: 'ctl-2', state: 'REJECTED', opportunity: 0},
      {id: 'ctl-3', state: 'REJECTED', opportunity: 0},
      {id: 'opp-1', state: 'BREAKOUT', opportunity: 1},
      {id: 'opp-2', state: 'BREAKOUT', opportunity: 1},
      {id: 'act-1', state: 'BUILDING', opportunity: 0},
    ];
    for (const [index, row] of rows.entries()) {
      const detectedAt = base + index * MINUTE;
      const snapshot = snapshotFromPair(pair({pairCreatedAt: detectedAt - 48 * HOUR}), detectedAt);
      const assessment = {...scoreCandidate(snapshot), modelVersion: MODEL_VERSION, state: row.state, opportunity: row.opportunity === 1};
      d1.sqlite.prepare('INSERT INTO goldmine_signals (id, address, pair, symbol, model_version, state, score, opportunity, detected_at, detected_price, snapshot, assessment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(row.id, snapshot.address, snapshot.pair, snapshot.symbol, MODEL_VERSION, row.state, assessment.score, row.opportunity, detectedAt, snapshot.priceUsd, JSON.stringify(snapshot), JSON.stringify(assessment));
      d1.sqlite.prepare('INSERT INTO goldmine_outcomes (signal_id, horizon, due_at, deadline_at, status, observed_at, price, liquidity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(row.id, 'd1', detectedAt + DAY, detectedAt + DAY + OBSERVATION_GRACE_MS, 'observed', detectedAt + DAY, snapshot.priceUsd * 1.1, 100000);
    }

    const {signals, outcomes} = await readAllSignalsWithOutcomes(d1);
    const split = denominatorSplit(signals, outcomes, clock.now());
    assert.deepEqual([split.control.signals, split.control.observedReturns], [3, 3]);
    assert.deepEqual([split.strategy.signals, split.strategy.observedReturns], [3, 3]);
    assert.deepEqual([split.opportunity.signals, split.opportunity.observedReturns], [2, 2]);
    assert.equal(split.control.signals + split.strategy.signals, signals.length,
      'control and strategy partition the signals exactly; opportunity is nested inside strategy, never added');
    assert.ok(split.opportunity.signals < split.strategy.signals);

    const totals = await readSignalTotals(d1);
    assert.deepEqual(totals, {signals: 6, opportunities: 2, control: 3, strategy: 3});

    // The per-state performance buckets keep them apart too: there is no bucket mixing REJECTED with an
    // actionable state.
    const buckets = performanceReport(signals, outcomes, clock.now());
    const states = new Set(buckets.map(bucket => bucket.state));
    assert.deepEqual([...states].sort(), ['BREAKOUT', 'BUILDING', 'REJECTED']);
  });

  test('a REJECTED signal is never counted as strategy even if its stored opportunity flag disagrees', async () => {
    const detectedAt = clock.now();
    const snapshot = snapshotFromPair(pair(), detectedAt);
    const assessment = {...scoreCandidate(snapshot), modelVersion: MODEL_VERSION, state: 'REJECTED', opportunity: true};
    d1.sqlite.prepare('INSERT INTO goldmine_signals (id, address, pair, symbol, model_version, state, score, opportunity, detected_at, detected_price, snapshot, assessment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('odd-1', snapshot.address, snapshot.pair, snapshot.symbol, MODEL_VERSION, 'REJECTED', assessment.score, 1, detectedAt, snapshot.priceUsd, JSON.stringify(snapshot), JSON.stringify(assessment));
    const {signals, outcomes} = await readAllSignalsWithOutcomes(d1);
    const split = denominatorSplit(signals, outcomes, clock.now());
    assert.deepEqual([split.control.signals, split.strategy.signals, split.opportunity.signals], [1, 0, 0]);
    // The all-history counts must apply the same rule, or the two paths disagree about the same row and
    // the documented nesting (opportunities inside strategy) stops holding.
    const totals = await readSignalTotals(d1);
    assert.deepEqual([totals.signals, totals.control, totals.strategy, totals.opportunities], [1, 1, 0, 0],
      'a REJECTED row claiming opportunity = 1 is control only: never an opportunity outside the strategy denominator');
    assert.ok(totals.opportunities <= totals.strategy, 'opportunities must stay nested inside strategy');
  });
});

describe('all-history counts', () => {
  // Requirement 14.
  test('zero opportunities is reported as zero, not as missing data', async () => {
    await record(clock.now());
    const totals = await readSignalTotals(d1);
    assert.equal(totals.opportunities, 0, 'the fixture candidate has no verified contract safety, so it is not an opportunity');
    assert.equal(totals.signals, 1);
  });

  test('an empty table reports zeros rather than nulls', async () => {
    assert.deepEqual(await readSignalTotals(d1), {signals: 0, opportunities: 0, control: 0, strategy: 0});
  });

  test('the count is over all stored history, independent of the bounded read', async () => {
    const base = clock.now();
    for (let index = 0; index < 5; index++) await record(base + index * 7 * HOUR, {pairAddress: addresses.pairA});
    const totals = await readSignalTotals(d1);
    const bounded = await readAllSignalsWithOutcomes(d1, {signalBatchSize: 2, maxSignalBatches: 1});
    assert.equal(bounded.truncated, true, 'the bounded read deliberately does not see everything');
    assert.ok(totals.signals > bounded.signals.length, 'the all-history count is not limited by the read bound');
    assert.equal(totals.signals, d1.rows('SELECT COUNT(*) AS n FROM goldmine_signals')[0].n);
  });

  test('readSignalTotals issues one read-only query and writes nothing', async () => {
    await record(clock.now());
    const before = rawSnapshot();
    d1.queries.length = 0;
    await readSignalTotals(d1);
    assert.equal(d1.queries.length, 1, 'one grouped COUNT, whatever the size of history');
    assert.ok(d1.queries.every(sql => sql.trim().toUpperCase().startsWith('SELECT')));
    assert.equal(rawSnapshot(), before);
  });
});

describe('active horizon definitions agree with what is written', () => {
  test('the three active horizons written to storage are exactly ACTIVE_HORIZONS', async () => {
    await record(clock.now());
    const written = outcomeRows().map(row => row.horizon);
    assert.deepEqual(written, ACTIVE_HORIZONS.map(horizon => horizon.id));
    assert.equal(written.length, 3);
  });

  test('a scan settles outcomes before it records new ones, so a signal is never settled by its own scan', async () => {
    const detectedAt = clock.now();
    await record(detectedAt);
    // Settling at the detection instant must find nothing due: the earliest due_at is a full day away.
    const run = await evaluateOutcomes(d1, detectedAt);
    assert.deepEqual(run, {provider: 'not_needed', observed: 0, unavailable: 0, missed: 0, deferred: 0});
    assert.ok(outcomeRows().every(row => row.due_at > detectedAt));
  });
});
