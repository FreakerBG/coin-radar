// Pure view logic for the Goldmine "Backtesting & Calibration" section (lib/goldmine/backtest-view.ts).
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

const {hasEnoughData, performanceRowsWithData, coverageTotal, coverageLabel, MIN_SIGNALS_FOR_REPORT} = await import('../lib/goldmine/backtest-view.ts');

describe('hasEnoughData', () => {
  test('null report: not enough data', () => assert.equal(hasEnoughData(null), false));
  test('below the threshold: not enough data', () => assert.equal(hasEnoughData({totalSignals: MIN_SIGNALS_FOR_REPORT - 1}), false));
  test('at or above the threshold: enough data', () => {
    assert.equal(hasEnoughData({totalSignals: MIN_SIGNALS_FOR_REPORT}), true);
    assert.equal(hasEnoughData({totalSignals: MIN_SIGNALS_FOR_REPORT + 50}), true);
  });
});

describe('performanceRowsWithData', () => {
  const bucket = (overrides = {}) => ({modelVersion: 'v', state: 'BREAKOUT', horizon: '15m', coverage: {pending: 0, observed: 0, unavailable: 0, missed: 0}, returnsPct: {count: 0, mean: null, median: null, stdev: null}, positiveShare: null, ...overrides});

  test('a bucket with no coverage at all is filtered out', () => {
    assert.deepEqual(performanceRowsWithData([bucket()]), []);
  });
  test('a bucket with only pending/unavailable/missed coverage is kept (it is real information)', () => {
    const b = bucket({coverage: {pending: 2, observed: 0, unavailable: 0, missed: 0}});
    assert.deepEqual(performanceRowsWithData([b]), [b]);
  });
  test('a bucket with observed returns is kept', () => {
    const b = bucket({coverage: {pending: 0, observed: 3, unavailable: 0, missed: 0}, returnsPct: {count: 3, mean: 5, median: 4, stdev: 1}});
    assert.deepEqual(performanceRowsWithData([b]), [b]);
  });
});

describe('coverageTotal / coverageLabel', () => {
  test('sums every status', () => {
    assert.equal(coverageTotal({pending: 1, observed: 2, unavailable: 3, missed: 4}), 10);
  });
  test('zero coverage is labeled honestly, not as a report with zero return', () => {
    assert.equal(coverageLabel({pending: 0, observed: 0, unavailable: 0, missed: 0}), 'No outcomes recorded yet.');
  });
  test('a populated bucket reports every status, not only observed', () => {
    assert.equal(coverageLabel({pending: 1, observed: 2, unavailable: 0, missed: 1}), '2/4 observed, 1 pending, 0 unavailable, 1 missed.');
  });
});
