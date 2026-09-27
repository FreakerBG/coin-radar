// GET /api/goldmine/backtest: read-only backtesting/calibration over already-stored goldmine_signals and
// goldmine_outcomes rows. No provider call is possible here (no fetch double is installed) and every
// assertion about "no mutation" is checked against the raw D1 rows before and after the request.
import assert from 'node:assert/strict';
import {beforeEach, describe, test} from 'node:test';
import {addresses, body, createD1, jsonRequest, runtime, signIn, signOut, startClock} from './helpers/harness.mjs';
import {pair} from './helpers/goldmine-fixtures.mjs';

const {GET} = await import('../app/api/goldmine/backtest/route.ts');
const {MODEL_VERSION, scoreCandidate} = await import('../lib/goldmine/score.ts');
const {snapshotFromPair} = await import('../lib/goldmine/snapshot.ts');

const MINUTE = 60000, HOUR = 60 * MINUTE;
let d1, clock;

const read = () => GET(jsonRequest('/api/goldmine/backtest'));

function insertSignal({id, detectedAt, modelVersion = MODEL_VERSION, state, snapshotOverrides = {}, snapshotJson, assessmentJson}) {
  const snapshot = snapshotJson ? JSON.parse(snapshotJson) : snapshotFromPair(pair(snapshotOverrides), detectedAt);
  const assessment = assessmentJson ? JSON.parse(assessmentJson) : {...scoreCandidate(snapshot), modelVersion};
  d1.sqlite.prepare('INSERT INTO goldmine_signals (id, address, pair, symbol, model_version, state, score, opportunity, detected_at, detected_price, snapshot, assessment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, snapshot.address, snapshot.pair, snapshot.symbol, modelVersion, state ?? assessment.state, assessment.score, assessment.opportunity ? 1 : 0, detectedAt, snapshot.priceUsd ?? 1, JSON.stringify(snapshot), JSON.stringify(assessment));
  return {snapshot, assessment};
}
function insertOutcome(signalId, horizon, {status = 'pending', dueAt, deadlineAt, observedAt = null, price = null, liquidity = null} = {}) {
  d1.sqlite.prepare('INSERT INTO goldmine_outcomes (signal_id, horizon, due_at, deadline_at, status, observed_at, price, liquidity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(signalId, horizon, dueAt, deadlineAt ?? dueAt + MINUTE, status, observedAt, price, liquidity);
}

beforeEach(() => {
  clock = startClock();
  d1 = createD1();
  runtime.env.DB = d1;
  signIn('user-a');
});

describe('access', () => {
  test('sign-in is required', async () => {
    signOut();
    assert.equal((await read()).status, 401);
  });

  test('without the D1 binding it fails closed before touching storage', async () => {
    delete runtime.env.DB;
    const response = await read();
    assert.equal(response.status, 503);
    assert.deepEqual(await body(response), {error: 'Backtest storage unavailable.'});
  });
});

describe('empty history', () => {
  test('degrades gracefully with zero signals: no crash, calibration is null, empty report arrays', async () => {
    const data = await body(await read());
    assert.equal(data.modelVersion, MODEL_VERSION);
    assert.equal(data.evaluationScheduleVersion, 'daily-snapshot-v1');
    assert.equal(data.totalSignals, 0);
    assert.deepEqual(data.totals, {signals: 0, opportunities: 0, control: 0, strategy: 0});
    assert.deepEqual(data.performance, []);
    assert.equal(data.calibration, null);
    assert.deepEqual(data.replay, {
      currentVersionSignals: 0, matched: 0, mismatchedCount: 0, mismatchedSample: [], mismatchedSampleTruncated: false,
      unsupportedCount: 0, unsupportedModelVersions: [], invalidCount: 0,
    });
    assert.ok(Array.isArray(data.limitations) && data.limitations.length > 0);
    assert.equal(data.skippedMalformedOutcomes, 0);
  });
});

describe('replay', () => {
  test('a signal stored under the current model version replays and matches; the stored row is untouched', async () => {
    const now = clock.now();
    insertSignal({id: 'sig-1', detectedAt: now});
    const before = d1.rows('SELECT * FROM goldmine_signals');
    const data = await body(await read());
    assert.deepEqual(data.replay, {
      currentVersionSignals: 1, matched: 1, mismatchedCount: 0, mismatchedSample: [], mismatchedSampleTruncated: false,
      unsupportedCount: 0, unsupportedModelVersions: [], invalidCount: 0,
    });
    assert.deepEqual(d1.rows('SELECT * FROM goldmine_signals'), before, 'replay never mutates the stored signal row');
  });

  test('a signal stored under a different model version is reported unsupported, never rescored as current', async () => {
    const now = clock.now();
    insertSignal({id: 'sig-legacy', detectedAt: now, modelVersion: 'momentum-v1.0.0'});
    const data = await body(await read());
    assert.deepEqual(data.replay, {
      currentVersionSignals: 0, matched: 0, mismatchedCount: 0, mismatchedSample: [], mismatchedSampleTruncated: false,
      unsupportedCount: 1, unsupportedModelVersions: ['momentum-v1.0.0'], invalidCount: 0,
    });
  });

  test('a corrupt stored snapshot/assessment row is skipped, not crashed on, and reported in skippedMalformedRows', async () => {
    d1.sqlite.prepare('INSERT INTO goldmine_signals (id, address, pair, symbol, model_version, state, score, opportunity, detected_at, detected_price, snapshot, assessment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('sig-corrupt', addresses.tokenA, addresses.pairA, 'FIX', MODEL_VERSION, 'BREAKOUT', 81, 0, clock.now(), 0.01, '{not valid json', '{}');
    const data = await body(await read());
    assert.equal(data.totalSignals, 0);
    assert.equal(data.skippedMalformedRows, 1);
  });

  test('a stored row with {status:"unsafe"} and no failedChecks never crashes the endpoint - other valid rows are still reported (200, not 503)', async () => {
    const now = clock.now();
    const badSnapshot = {...snapshotFromPair(pair(), now), contractSafety: {status: 'unsafe'}};
    d1.sqlite.prepare('INSERT INTO goldmine_signals (id, address, pair, symbol, model_version, state, score, opportunity, detected_at, detected_price, snapshot, assessment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('sig-bad-safety', badSnapshot.address, badSnapshot.pair, badSnapshot.symbol, MODEL_VERSION, 'BREAKOUT', 81, 0, now, badSnapshot.priceUsd,
        JSON.stringify(badSnapshot), JSON.stringify({...scoreCandidate(snapshotFromPair(pair(), now)), modelVersion: MODEL_VERSION}));
    insertSignal({id: 'sig-ok', detectedAt: now + 1});
    const response = await read();
    assert.equal(response.status, 200);
    const data = await body(response);
    assert.equal(data.totalSignals, 1);
    assert.equal(data.skippedMalformedRows, 1);
  });
});

describe('malformed outcomes', () => {
  test('an unknown outcome status is excluded and counted in skippedMalformedOutcomes, never inflating pending coverage', async () => {
    const now = clock.now();
    insertSignal({id: 'sig-1', detectedAt: now});
    d1.sqlite.prepare('INSERT INTO goldmine_outcomes (signal_id, horizon, due_at, deadline_at, status, observed_at, price, liquidity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('sig-1', '15m', now, now + MINUTE, 'CORRUPT', null, null, null);
    const data = await body(await read());
    assert.equal(data.skippedMalformedOutcomes, 1);
    const byHorizon = Object.fromEntries(data.performance.map(bucket => [bucket.horizon, bucket]));
    assert.equal(byHorizon['15m'], undefined, 'the malformed row never contributes to any coverage bucket, pending or otherwise');
  });
});

describe('performance report', () => {
  test('outcome coverage includes pending/unavailable/missed, never collapsed to zero or dropped', async () => {
    const now = clock.now();
    const {snapshot} = insertSignal({id: 'sig-1', detectedAt: now, snapshotOverrides: {}});
    insertOutcome('sig-1', '15m', {status: 'observed', dueAt: now + 15 * MINUTE, price: snapshot.priceUsd * 1.2, liquidity: 1000, observedAt: now + 15 * MINUTE});
    insertOutcome('sig-1', '1h', {status: 'pending', dueAt: now + HOUR});
    insertOutcome('sig-1', '6h', {status: 'unavailable', dueAt: now + 6 * HOUR, observedAt: now + 6 * HOUR});
    insertOutcome('sig-1', '24h', {status: 'missed', dueAt: now + 24 * HOUR});
    const data = await body(await read());
    const byHorizon = Object.fromEntries(data.performance.map(bucket => [bucket.horizon, bucket]));
    assert.deepEqual(byHorizon['15m'].coverage, {pending: 0, expiredUnswept: 0, observed: 1, unavailable: 0, missed: 0});
    assert.equal(byHorizon['15m'].returnsPct.count, 1);
    // The 1h row's window is still open at the read timestamp, so it is genuinely live pending. The
    // expired-unswept case is covered separately below and in tests/goldmine-outcome-schedule.test.mjs.
    assert.deepEqual(byHorizon['1h'].coverage, {pending: 1, expiredUnswept: 0, observed: 0, unavailable: 0, missed: 0});
    assert.deepEqual(byHorizon['6h'].coverage, {pending: 0, expiredUnswept: 0, observed: 0, unavailable: 1, missed: 0});
    assert.deepEqual(byHorizon['24h'].coverage, {pending: 0, expiredUnswept: 0, observed: 0, unavailable: 0, missed: 1});
    // Every legacy horizon is reported as belonging to the superseded schedule and as unobservable on this
    // deployment's once-daily cadence.
    for (const horizon of ['15m', '1h', '6h', '24h']) {
      assert.equal(byHorizon[horizon].horizonActive, false, horizon);
      assert.equal(byHorizon[horizon].observableUnderCadence, false, horizon);
      assert.equal(byHorizon[horizon].horizonSchedule, 'intraday-v0', horizon);
    }
    // Never mutated the outcome rows either.
    const outcomes = d1.rows('SELECT status FROM goldmine_outcomes ORDER BY horizon');
    assert.deepEqual(outcomes.map(o => o.status).sort(), ['missed', 'observed', 'pending', 'unavailable']);
  });
});

// Stage 06: everything a consumer needs in order to read the outcome evidence honestly has to be in the
// response, not only derivable from it.
describe('cadence, all-history totals and separate denominators', () => {
  test('reports the evaluation schedule version separately from the scoring model version', async () => {
    const data = await body(await read());
    assert.equal(data.evaluationScheduleVersion, 'daily-snapshot-v1');
    assert.equal(data.modelVersion, MODEL_VERSION);
    assert.notEqual(data.evaluationScheduleVersion, data.modelVersion);
  });

  test('reports the cadence, and for every known horizon its target, grace window and observability', async () => {
    const data = await body(await read());
    assert.equal(data.cadence.cronExpression, '0 0 * * *');
    assert.equal(data.cadence.scanCadenceMs, 24 * HOUR);
    assert.equal(data.cadence.maxScanGapMs, 24 * HOUR + 59 * MINUTE);
    assert.equal(data.cadence.observationGraceMs, 26 * HOUR);
    assert.ok(data.cadence.observationGraceBufferMs > 0);
    assert.deepEqual(data.cadence.horizons.map(h => [h.id, h.active, h.observableUnderCadence, h.targetMs, h.graceWindowMs]), [
      ['15m', false, false, 15 * MINUTE, 5 * MINUTE],
      ['1h', false, false, HOUR, 15 * MINUTE],
      ['6h', false, false, 6 * HOUR, HOUR],
      ['24h', false, false, 24 * HOUR, 3 * HOUR],
      ['d1', true, true, 24 * HOUR, 26 * HOUR],
      ['d3', true, true, 72 * HOUR, 26 * HOUR],
      ['d7', true, true, 168 * HOUR, 26 * HOUR],
    ]);
    assert.match(data.cadence.exactTargetBoundaryNote, /never guaranteed to be exactly the target age/);
    assert.ok(typeof data.generatedAt === 'number' && Number.isFinite(data.generatedAt));
  });

  test('the all-history opportunity count is zero when nothing ever cleared every gate, and is not the bounded read count', async () => {
    const now = clock.now();
    // Five signals, none an opportunity (the fixture candidate has no verified contract safety).
    for (let index = 0; index < 5; index++) insertSignal({id: `sig-${index}`, detectedAt: now + index});
    const data = await body(await read());
    assert.equal(data.totals.signals, 5);
    assert.equal(data.totals.opportunities, 0, 'zero is reported as zero, never omitted');
    assert.equal(data.totals.control + data.totals.strategy, data.totals.signals,
      'control and strategy partition every recorded signal exactly');
  });

  test('control and strategy denominators are reported apart, and an opportunity is never added to either', async () => {
    const now = clock.now();
    // Genuinely rejected candidates, produced by the real scorer (thin liquidity is a hard gate), not by
    // overriding the stored state column: a row whose column and assessment disagree is malformed data and
    // is excluded from the read entirely.
    insertSignal({id: 'ctl-1', detectedAt: now, snapshotOverrides: {liquidity: {usd: 20000}}});
    insertSignal({id: 'ctl-2', detectedAt: now + 1, snapshotOverrides: {liquidity: {usd: 20000}}});
    insertSignal({id: 'act-1', detectedAt: now + 2});
    insertOutcome('ctl-1', 'd1', {status: 'observed', dueAt: now + 24 * HOUR, deadlineAt: now + 50 * HOUR, observedAt: now + 24 * HOUR, price: 1.5});
    insertOutcome('act-1', 'd1', {status: 'observed', dueAt: now + 24 * HOUR, deadlineAt: now + 50 * HOUR, observedAt: now + 24 * HOUR, price: 1.5});
    const data = await body(await read());
    assert.equal(data.denominators.control.signals, 2);
    assert.equal(data.denominators.control.observedReturns, 1);
    assert.equal(data.denominators.strategy.signals, 1);
    assert.equal(data.denominators.strategy.observedReturns, 1);
    assert.notEqual(data.denominators.control.observedReturns + data.denominators.strategy.observedReturns, data.denominators.strategy.observedReturns,
      'the two are genuinely distinct numbers, reported side by side rather than summed');
    assert.ok(data.denominators.opportunity.signals <= data.denominators.strategy.signals,
      'opportunity is nested inside strategy, never a fourth independent population');
  });

  test('the limitations name the cadence problem, the daily-snapshot meaning and the control group', async () => {
    const data = await body(await read());
    const text = data.limitations.join(' ');
    assert.match(text, /legacy 15m, 1h, 6h and 24h horizons cannot be evaluated/);
    assert.match(text, /not exact-time execution prices/);
    assert.match(text, /REJECTED signals are recorded and evaluated as a control group/);
    assert.match(text, /expired-unswept/);
  });

  test('the report is read-only: a request never writes a row, even with expired-unswept outcomes present', async () => {
    const now = clock.now();
    insertSignal({id: 'sig-1', detectedAt: now});
    // A pending row whose window closed long ago, which no scan has swept yet.
    insertOutcome('sig-1', 'd1', {status: 'pending', dueAt: now - 50 * HOUR, deadlineAt: now - 2 * HOUR});
    const before = JSON.stringify(d1.rows('SELECT * FROM goldmine_outcomes'));
    const data = await body(await read());
    const bucket = data.performance.find(entry => entry.horizon === 'd1');
    assert.deepEqual(bucket.coverage, {pending: 0, expiredUnswept: 1, observed: 0, unavailable: 0, missed: 0});
    assert.equal(JSON.stringify(d1.rows('SELECT * FROM goldmine_outcomes')), before, 'the row is reported, never rewritten');
  });
});

describe('calibration', () => {
  test('with enough signals, reports a threshold sweep restricted to the later (evaluation) half', async () => {
    const base = clock.now();
    // 24 signals detected across a day, all BREAKOUT with score 65 and every non-score gate cleared, so
    // wouldBeOpportunityAt(65) is true at every threshold <= 65 and false above it. Half of them (the
    // earlier ones) form the reference half and must not affect the reported rows.
    for (let i = 0; i < 24; i++) {
      const detectedAt = base + i * HOUR;
      const {snapshot} = insertSignal({id: `sig-${i}`, detectedAt, snapshotOverrides: {liquidity: {usd: 90000}, priceChange: {h1: 12}}});
      insertOutcome(`sig-${i}`, '15m', {status: 'observed', dueAt: detectedAt + 15 * MINUTE, observedAt: detectedAt + 15 * MINUTE, price: snapshot.priceUsd * 1.1});
    }
    const data = await body(await read());
    assert.ok(data.calibration);
    assert.equal(data.calibration.referenceCount + data.calibration.evaluationCount, 24);
    assert.ok(data.calibration.evaluationCount >= 1);
    assert.deepEqual(data.calibration.rows.map(r => r.threshold), [40, 50, 60, 70, 80, 90]);
  });

  test('with few signals, calibration is still returned but flagged descriptiveOnly', async () => {
    insertSignal({id: 'sig-1', detectedAt: clock.now()});
    const data = await body(await read());
    assert.ok(data.calibration);
    assert.equal(data.calibration.descriptiveOnly, true);
  });
});
