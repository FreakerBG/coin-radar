// Pure logic for Goldmine backtesting/calibration (lib/goldmine/backtest.ts): deterministic replay,
// distribution stats, per-bucket outcome coverage and the calibration threshold sweep. No D1, no network.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {pair} from './helpers/goldmine-fixtures.mjs';

const {replaySignal, replayAll, distribution, performanceReport, wouldBeOpportunityAt, calibrationSweep, defaultCutoff, MIN_EVALUATION_SIGNALS, MIN_OBSERVED_RETURN_SAMPLES, CALIBRATION_THRESHOLDS} = await import('../lib/goldmine/backtest.ts');
const {scoreCandidate, MODEL_VERSION} = await import('../lib/goldmine/score.ts');
const {snapshotFromPair} = await import('../lib/goldmine/snapshot.ts');

const NOW = Date.UTC(2026, 8, 18, 12);
const MINUTE = 60000, HOUR = 60 * MINUTE;

function makeSignal(overrides = {}, {detectedAt = NOW, id, modelVersion = MODEL_VERSION, snapshotOverrides = {}} = {}) {
  const snapshot = {...snapshotFromPair(pair(snapshotOverrides), detectedAt), ...overrides.snapshotExtra};
  const assessment = overrides.assessment ?? scoreCandidate(snapshot);
  return {
    id: id ?? `sig-${snapshot.address}-${detectedAt}`,
    address: snapshot.address, pair: snapshot.pair, symbol: snapshot.symbol,
    modelVersion, state: assessment.state, score: assessment.score, opportunity: assessment.opportunity,
    detectedAt, detectedPrice: snapshot.priceUsd ?? 1,
    snapshot, assessment: {...assessment, modelVersion},
  };
}

describe('replaySignal', () => {
  test('a signal stored under the current model version replays to reproduce the stored assessment exactly', () => {
    const signal = makeSignal();
    const result = replaySignal(signal);
    assert.equal(result.supported, true);
    assert.equal(result.matchesStored, true);
    assert.deepEqual(result.recomputed, signal.assessment);
  });

  test('a signal stored under a different model version is marked unsupported, never silently rescored under the current model', () => {
    const signal = makeSignal({}, {modelVersion: 'momentum-v1.0.0'});
    const result = replaySignal(signal);
    assert.equal(result.supported, false);
    assert.equal(result.modelVersion, 'momentum-v1.0.0');
    assert.match(result.reason, /No implementation of model version momentum-v1\.0\.0/);
    assert.match(result.reason, new RegExp(MODEL_VERSION.replace(/\./g, '\\.')));
    // The unsupported result carries no recomputed field at all - nothing here has been run through
    // scoreCandidate and relabeled as this signal's historical result.
    assert.equal('recomputed' in result, false);
    assert.equal('matchesStored' in result, false);
  });

  test('replay never mutates the input signal (snapshot, assessment or any other field)', () => {
    const signal = makeSignal();
    const before = JSON.stringify(signal);
    replaySignal(signal);
    assert.equal(JSON.stringify(signal), before);
  });

  test('a hand-mutated stored assessment (simulating drift or tampering) is caught as a mismatch, not silently accepted', () => {
    const signal = makeSignal();
    signal.assessment = {...signal.assessment, score: signal.assessment.score + 1};
    const result = replaySignal(signal);
    assert.equal(result.supported, true);
    assert.equal(result.matchesStored, false);
  });
});

describe('replayAll', () => {
  test('summarizes matched, mismatched and unsupported signals separately', () => {
    const matching = makeSignal({}, {id: 'a'});
    const drifted = makeSignal({}, {id: 'b', snapshotOverrides: {liquidity: {usd: 90000}}});
    drifted.assessment = {...drifted.assessment, score: 999};
    const legacy = makeSignal({}, {id: 'c', modelVersion: 'momentum-v2.0.0'});
    const summary = replayAll([matching, drifted, legacy]);
    assert.equal(summary.totalSignals, 3);
    assert.equal(summary.currentVersionSignals, 2);
    assert.equal(summary.matched, 1);
    assert.deepEqual(summary.mismatched.map(m => m.signalId), ['b']);
    assert.equal(summary.unsupportedCount, 1);
    assert.deepEqual(summary.unsupportedModelVersions, ['momentum-v2.0.0']);
  });

  test('an empty input never crashes and reports all zeros', () => {
    assert.deepEqual(replayAll([]), {totalSignals: 0, currentVersionSignals: 0, matched: 0, mismatched: [], unsupportedModelVersions: [], unsupportedCount: 0});
  });
});

describe('distribution', () => {
  test('no values: everything is null, count is zero, never a fabricated zero-return', () => {
    assert.deepEqual(distribution([]), {count: 0, mean: null, median: null, stdev: null});
  });
  test('a single value: mean and median equal it; stdev is null, not zero (spread is undefined with one sample)', () => {
    assert.deepEqual(distribution([10]), {count: 1, mean: 10, median: 10, stdev: null});
  });
  test('an even count uses the average of the two middle values for the median', () => {
    const d = distribution([10, 20, 30, 40]);
    assert.deepEqual([d.count, d.mean, d.median], [4, 25, 25]);
    assert.ok(d.stdev > 0);
  });
  test('an odd count uses the middle value for the median, independent of input order', () => {
    assert.deepEqual(distribution([30, 10, 20]).median, 20);
  });
  test('known sample standard deviation matches a hand-computed value', () => {
    // Values 2,4,4,4,5,5,7,9: mean 5, sample variance 32/7, stdev ~2.1381
    const d = distribution([2, 4, 4, 4, 5, 5, 7, 9]);
    assert.equal(d.mean, 5);
    assert.ok(Math.abs(d.stdev - 2.1381) < 0.001, d.stdev);
  });
});

describe('performanceReport', () => {
  const signal = (state, id, detectedPrice = 1) => ({
    id, address: 'Addr' + id, pair: 'Pair' + id, symbol: 'SYM', modelVersion: MODEL_VERSION, state,
    score: 70, opportunity: state !== 'REJECTED', detectedAt: NOW, detectedPrice,
    snapshot: {}, assessment: {modelVersion: MODEL_VERSION, state, score: 70, opportunity: state !== 'REJECTED', blockers: [], rejections: [], components: [], risks: [], summary: '', disclaimer: '', address: 'Addr' + id, pair: 'Pair' + id, symbol: 'SYM', observedAt: NOW, priceUsd: detectedPrice},
  });

  test('every outcome status is counted in coverage; pending/unavailable/missed are never dropped or treated as zero return', () => {
    const signals = [signal('BREAKOUT', 's1', 1)];
    const outcomes = [
      {signalId: 's1', horizon: '15m', status: 'observed', dueAt: NOW, observedAt: NOW, price: 1.2, liquidity: 1000},
      {signalId: 's1', horizon: '1h', status: 'pending', dueAt: NOW, observedAt: null, price: null, liquidity: null},
      {signalId: 's1', horizon: '6h', status: 'unavailable', dueAt: NOW, observedAt: NOW, price: null, liquidity: null},
      {signalId: 's1', horizon: '24h', status: 'missed', dueAt: NOW, observedAt: null, price: null, liquidity: null},
    ];
    const report = performanceReport(signals, outcomes);
    const byHorizon = Object.fromEntries(report.map(bucket => [bucket.horizon, bucket]));
    assert.deepEqual(byHorizon['15m'].coverage, {pending: 0, observed: 1, unavailable: 0, missed: 0});
    assert.equal(byHorizon['15m'].returnsPct.count, 1);
    assert.equal(byHorizon['15m'].returnsPct.mean, 20);
    assert.deepEqual(byHorizon['1h'].coverage, {pending: 1, observed: 0, unavailable: 0, missed: 0});
    assert.equal(byHorizon['1h'].returnsPct.count, 0, 'a pending outcome contributes no return, not a zero return');
    assert.deepEqual(byHorizon['6h'].coverage, {pending: 0, observed: 0, unavailable: 1, missed: 0});
    assert.equal(byHorizon['6h'].returnsPct.count, 0);
    assert.deepEqual(byHorizon['24h'].coverage, {pending: 0, observed: 0, unavailable: 0, missed: 1});
    assert.equal(byHorizon['24h'].returnsPct.count, 0);
  });

  test('buckets are grouped separately per model version x state x horizon', () => {
    const signals = [signal('BREAKOUT', 's1'), signal('EARLY', 's2'), {...signal('BREAKOUT', 's3'), modelVersion: 'momentum-v2.0.0'}];
    const outcomes = [
      {signalId: 's1', horizon: '15m', status: 'observed', dueAt: NOW, observedAt: NOW, price: 1.1, liquidity: 1},
      {signalId: 's2', horizon: '15m', status: 'observed', dueAt: NOW, observedAt: NOW, price: 0.9, liquidity: 1},
      {signalId: 's3', horizon: '15m', status: 'observed', dueAt: NOW, observedAt: NOW, price: 1.5, liquidity: 1},
    ];
    const report = performanceReport(signals, outcomes);
    assert.equal(report.length, 3);
    const keys = report.map(b => `${b.modelVersion}:${b.state}:${b.horizon}`).sort();
    assert.deepEqual(keys, ['momentum-v2.0.0:BREAKOUT:15m', `${MODEL_VERSION}:BREAKOUT:15m`, `${MODEL_VERSION}:EARLY:15m`].sort());
  });

  test('an outcome referencing an unknown signal id is ignored rather than crashing', () => {
    const report = performanceReport([signal('BREAKOUT', 's1')], [{signalId: 'missing', horizon: '15m', status: 'observed', dueAt: NOW, observedAt: NOW, price: 1, liquidity: 1}]);
    assert.deepEqual(report, []);
  });

  test('never mutates its inputs', () => {
    const signals = [signal('BREAKOUT', 's1')];
    const outcomes = [{signalId: 's1', horizon: '15m', status: 'observed', dueAt: NOW, observedAt: NOW, price: 1.2, liquidity: 1}];
    const before = JSON.stringify([signals, outcomes]);
    performanceReport(signals, outcomes);
    assert.equal(JSON.stringify([signals, outcomes]), before);
  });
});

describe('wouldBeOpportunityAt', () => {
  const base = {state: 'BREAKOUT', score: 65, blockers: []};
  test('a REJECTED state is never an opportunity at any threshold', () => {
    assert.equal(wouldBeOpportunityAt({...base, state: 'REJECTED', score: 100}, 0), false);
  });
  test('meeting every other gate: eligible exactly when the score clears the threshold', () => {
    assert.equal(wouldBeOpportunityAt(base, 60), true);
    assert.equal(wouldBeOpportunityAt(base, 70), false);
  });
  test('a non-score blocker (e.g. unverified contract safety) is never overridden by a lower threshold', () => {
    const blocked = {...base, blockers: [{id: 'contract_safety_unverified', category: 'safety', message: ''}]};
    assert.equal(wouldBeOpportunityAt(blocked, 0), false);
  });
  test('only the score_below_threshold blocker is threshold-dependent', () => {
    const scoreBlocked = {...base, score: 55, blockers: [{id: 'score_below_threshold', category: 'momentum', message: ''}]};
    assert.equal(wouldBeOpportunityAt(scoreBlocked, 50), true);
    assert.equal(wouldBeOpportunityAt(scoreBlocked, 60), false);
  });
});

describe('defaultCutoff', () => {
  test('null with no signals', () => assert.equal(defaultCutoff([]), null));
  test('the median detection time, independent of input order', () => {
    const signals = [{detectedAt: 300}, {detectedAt: 100}, {detectedAt: 200}];
    assert.equal(defaultCutoff(signals), 200);
  });
});

describe('calibrationSweep', () => {
  function evalSignal(id, detectedAt, score, priceReturn) {
    const assessment = {state: 'BREAKOUT', score, blockers: score < 60 ? [{id: 'score_below_threshold', category: 'momentum', message: ''}] : []};
    return {
      id, address: 'Addr' + id, pair: 'Pair' + id, symbol: 'SYM', modelVersion: MODEL_VERSION, state: 'BREAKOUT',
      score, opportunity: score >= 60, detectedAt, detectedPrice: 1, snapshot: {}, assessment,
      _return: priceReturn,
    };
  }
  function outcomeFor(signal, horizon = '15m') {
    return {signalId: signal.id, horizon, status: 'observed', dueAt: signal.detectedAt, observedAt: signal.detectedAt, price: 1 * (1 + signal._return), liquidity: 1};
  }

  test('signals before the cutoff (the reference half) never contribute to any row, however extreme their outcome', () => {
    const reference = evalSignal('ref', NOW - HOUR, 90, 5); // +500% return, but strictly before cutoff
    const evaluation = evalSignal('eval', NOW, 65, 0.1);
    const result = calibrationSweep([reference, evaluation], [outcomeFor(reference), outcomeFor(evaluation)], {cutoffAt: NOW, thresholds: [60]});
    assert.equal(result.referenceCount, 1);
    assert.equal(result.evaluationCount, 1);
    const row = result.rows[0];
    assert.equal(row.eligibleCount, 1);
    assert.equal(row.byHorizon[0].returnsPct.mean, 10, 'only the evaluation-half signal contributes');
  });

  test('descriptiveOnly is true when the evaluation half has fewer than MIN_EVALUATION_SIGNALS signals', () => {
    const evaluation = evalSignal('eval', NOW, 65, 0.1);
    const result = calibrationSweep([evaluation], [outcomeFor(evaluation)], {cutoffAt: NOW - MINUTE});
    assert.equal(result.evaluationCount, 1);
    assert.ok(result.evaluationCount < MIN_EVALUATION_SIGNALS);
    assert.equal(result.descriptiveOnly, true);
    assert.ok(result.rows.length > 0, 'rows are still returned for visibility, not withheld');
  });

  test('descriptiveOnly is false once the evaluation half reaches MIN_EVALUATION_SIGNALS', () => {
    const evaluation = Array.from({length: MIN_EVALUATION_SIGNALS}, (_, i) => evalSignal('eval' + i, NOW + i, 65, 0.05));
    const outcomes = evaluation.map(s => outcomeFor(s));
    const result = calibrationSweep(evaluation, outcomes, {cutoffAt: NOW});
    assert.equal(result.evaluationCount, MIN_EVALUATION_SIGNALS);
    assert.equal(result.descriptiveOnly, false);
  });

  test('a higher threshold only ever narrows (never widens) the eligible set', () => {
    const evaluation = [evalSignal('a', NOW, 55, 0.1), evalSignal('b', NOW, 65, 0.1), evalSignal('c', NOW, 85, 0.1)];
    const outcomes = evaluation.map(s => outcomeFor(s));
    const result = calibrationSweep(evaluation, outcomes, {cutoffAt: NOW - 1, thresholds: [40, 60, 80]});
    const counts = result.rows.map(row => row.eligibleCount);
    assert.deepEqual(counts, [...counts].sort((a, b) => b - a), `eligible counts must be non-increasing as threshold rises: ${counts}`);
  });

  test('uses CALIBRATION_THRESHOLDS by default', () => {
    const result = calibrationSweep([], [], {cutoffAt: NOW});
    assert.deepEqual(result.rows.map(r => r.threshold), CALIBRATION_THRESHOLDS);
  });

  test('never mutates its inputs', () => {
    const evaluation = [evalSignal('a', NOW, 65, 0.1)];
    const outcomes = evaluation.map(s => outcomeFor(s));
    const before = JSON.stringify([evaluation, outcomes]);
    calibrationSweep(evaluation, outcomes, {cutoffAt: NOW - 1});
    assert.equal(JSON.stringify([evaluation, outcomes]), before);
  });

  // --- Coverage and evidence sufficiency (does not become "sufficient" merely from evaluation count) ----

  test('>= MIN_EVALUATION_SIGNALS evaluation signals with zero observed outcomes is still descriptiveOnly', () => {
    const evaluation = Array.from({length: MIN_EVALUATION_SIGNALS}, (_, i) => evalSignal('eval' + i, NOW + i, 65, 0.05));
    // No outcomes recorded for any of them at all (imagine every horizon still pending/unsettled).
    const result = calibrationSweep(evaluation, [], {cutoffAt: NOW});
    assert.equal(result.evaluationCount, MIN_EVALUATION_SIGNALS);
    assert.equal(result.descriptiveOnly, true, 'a large evaluation half with no observed outcomes must never read as sufficient evidence');
    const row60 = result.rows.find(r => r.threshold === 60);
    const horizon15m = row60.byHorizon.find(h => h.horizon === '15m');
    assert.equal(horizon15m.eligible, MIN_EVALUATION_SIGNALS);
    assert.deepEqual(horizon15m.coverage, {pending: 0, observed: 0, unavailable: 0, missed: 0}, 'missing outcomes are never guessed at as any status');
    assert.equal(horizon15m.eligibleWithOutcome, 0);
    assert.ok(horizon15m.eligibleWithOutcome < MIN_OBSERVED_RETURN_SAMPLES);
    assert.equal(horizon15m.sufficientEvidence, false);
  });

  test('partial outcome coverage: some signals observed, most pending - reported explicitly, not rounded up to sufficient', () => {
    const evaluation = Array.from({length: MIN_EVALUATION_SIGNALS}, (_, i) => evalSignal('eval' + i, NOW + i, 65, 0.05));
    // Only 3 of the 20 have an observed 15m outcome; the rest are pending.
    const outcomes = evaluation.map((s, i) => i < 3
      ? outcomeFor(s)
      : {signalId: s.id, horizon: '15m', status: 'pending', dueAt: s.detectedAt, observedAt: null, price: null, liquidity: 1});
    const result = calibrationSweep(evaluation, outcomes, {cutoffAt: NOW});
    const row60 = result.rows.find(r => r.threshold === 60);
    const horizon15m = row60.byHorizon.find(h => h.horizon === '15m');
    assert.deepEqual(horizon15m.coverage, {pending: 17, observed: 3, unavailable: 0, missed: 0});
    assert.equal(horizon15m.eligibleWithOutcome, 3);
    assert.equal(horizon15m.coverageRatio, Number((3 / 20).toFixed(4)));
    assert.equal(horizon15m.sufficientEvidence, false, 'only 3 observed returns, below MIN_OBSERVED_RETURN_SAMPLES');
    assert.equal(result.descriptiveOnly, true);
  });

  test('a threshold/horizon with eligible signals but zero observed returns is distinguished from one with none eligible', () => {
    const eligibleNoOutcome = evalSignal('a', NOW, 90, 0.1); // eligible at every threshold up to 90
    const outcome = {signalId: eligibleNoOutcome.id, horizon: '15m', status: 'unavailable', dueAt: NOW, observedAt: NOW, price: null, liquidity: null};
    const result = calibrationSweep([eligibleNoOutcome], [outcome], {cutoffAt: NOW - 1, thresholds: [90]});
    const horizon15m = result.rows[0].byHorizon.find(h => h.horizon === '15m');
    assert.equal(horizon15m.eligible, 1);
    assert.deepEqual(horizon15m.coverage, {pending: 0, observed: 0, unavailable: 1, missed: 0});
    assert.equal(horizon15m.eligibleWithOutcome, 0);
    assert.equal(horizon15m.returnsPct.count, 0, 'an unavailable outcome never becomes a zero return');
  });

  test('every outcome status (pending/observed/unavailable/missed) is separated correctly within a threshold/horizon cell', () => {
    const signals = [
      evalSignal('a', NOW, 90, 0.1), evalSignal('b', NOW, 90, 0.1),
      evalSignal('c', NOW, 90, 0.1), evalSignal('d', NOW, 90, 0.1),
    ];
    const outcomes = [
      outcomeFor(signals[0]),
      {signalId: signals[1].id, horizon: '15m', status: 'pending', dueAt: NOW, observedAt: null, price: null, liquidity: null},
      {signalId: signals[2].id, horizon: '15m', status: 'unavailable', dueAt: NOW, observedAt: NOW, price: null, liquidity: null},
      {signalId: signals[3].id, horizon: '15m', status: 'missed', dueAt: NOW, observedAt: null, price: null, liquidity: null},
    ];
    const result = calibrationSweep(signals, outcomes, {cutoffAt: NOW - 1, thresholds: [90]});
    const horizon15m = result.rows[0].byHorizon.find(h => h.horizon === '15m');
    assert.deepEqual(horizon15m.coverage, {pending: 1, observed: 1, unavailable: 1, missed: 1});
    assert.equal(horizon15m.eligible, 4);
  });

  // --- Model-version isolation ------------------------------------------------------------------------

  test('signals from an unsupported model version are excluded from calibration, never reinterpreted under the current thresholds', () => {
    const current = evalSignal('cur', NOW, 65, 0.1);
    // A different, unimplemented model version: an assessment shape that would be eligible under this
    // sweep's rules by coincidence, but must never be scored as if it were the current model's output.
    const legacy = {...evalSignal('legacy', NOW, 65, 0.1), modelVersion: 'momentum-v1.0.0'};
    const outcomes = [outcomeFor(current), outcomeFor(legacy)];
    const result = calibrationSweep([current, legacy], outcomes, {cutoffAt: NOW - 1, thresholds: [60]});
    assert.equal(result.modelVersion, 'momentum-v2.1.0');
    assert.equal(result.excludedOtherVersionSignals, 1);
    assert.equal(result.evaluationCount, 1, 'the legacy-version signal never joins the evaluation half');
    assert.equal(result.rows[0].eligibleCount, 1);
  });

  test('an explicit modelVersion option restricts the sweep to that version instead of the imported default', () => {
    const v1 = {...evalSignal('a', NOW, 65, 0.1), modelVersion: 'momentum-v1.0.0'};
    const v2 = evalSignal('b', NOW, 65, 0.1);
    const outcomes = [outcomeFor(v1), outcomeFor(v2)];
    const result = calibrationSweep([v1, v2], outcomes, {cutoffAt: NOW - 1, thresholds: [60], modelVersion: 'momentum-v1.0.0'});
    assert.equal(result.modelVersion, 'momentum-v1.0.0');
    assert.equal(result.excludedOtherVersionSignals, 1);
    assert.equal(result.evaluationCount, 1);
  });
});
