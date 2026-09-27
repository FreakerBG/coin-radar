// Pure view logic for the Goldmine "Backtesting & Calibration" section (lib/goldmine/backtest-view.ts).
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
// Imported only to register the module-resolution hook (tests/helpers/loader.mjs): backtest-view.ts reads
// the cadence facts from lib/goldmine/cadence.ts by an extensionless relative specifier, the same way every
// other application module does.
import './helpers/harness.mjs';

const {
  allHistoryOpportunityLabel, cadenceSummary, cellStatusLabel, coverageLabel, coverageTotal, dataQualityWarning,
  denominatorNote, hasDataQualityWarning, hasEnoughData, horizonLabel, horizonScheduleNote, legacyHorizonWarning,
  observedAfterLabel, performanceRowsWithData, signalsSummaryLabel, unobservableHorizons, MIN_SIGNALS_FOR_REPORT,
} = await import('../lib/goldmine/backtest-view.ts');
const {cadenceReport} = await import('../lib/goldmine/cadence.ts');

describe('hasEnoughData', () => {
  test('null report: not enough data', () => assert.equal(hasEnoughData(null), false));
  test('below the threshold: not enough data', () => assert.equal(hasEnoughData({totalSignals: MIN_SIGNALS_FOR_REPORT - 1}), false));
  test('at or above the threshold: enough data', () => {
    assert.equal(hasEnoughData({totalSignals: MIN_SIGNALS_FOR_REPORT}), true);
    assert.equal(hasEnoughData({totalSignals: MIN_SIGNALS_FOR_REPORT + 50}), true);
  });
});

describe('performanceRowsWithData', () => {
  const bucket = (overrides = {}) => ({
    modelVersion: 'v', state: 'BREAKOUT', horizon: '15m', horizonLabel: '15m (legacy)', horizonSchedule: 'intraday-v0',
    horizonActive: false, observableUnderCadence: false, targetHours: 0.25,
    coverage: {pending: 0, expiredUnswept: 0, observed: 0, unavailable: 0, missed: 0},
    returnsPct: {count: 0, mean: null, median: null, stdev: null}, positiveShare: null,
    observedAfterHours: {count: 0, mean: null, median: null, stdev: null}, ...overrides,
  });

  test('a bucket with no coverage at all is filtered out', () => {
    assert.deepEqual(performanceRowsWithData([bucket()]), []);
  });
  test('a bucket with only pending/unavailable/missed coverage is kept (it is real information)', () => {
    const b = bucket({coverage: {pending: 2, expiredUnswept: 0, observed: 0, unavailable: 0, missed: 0}});
    assert.deepEqual(performanceRowsWithData([b]), [b]);
  });
  test('a bucket with observed returns is kept', () => {
    const b = bucket({coverage: {pending: 0, expiredUnswept: 0, observed: 3, unavailable: 0, missed: 0}, returnsPct: {count: 3, mean: 5, median: 4, stdev: 1}});
    assert.deepEqual(performanceRowsWithData([b]), [b]);
  });
});

describe('coverageTotal / coverageLabel', () => {
  test('sums every derived state, including expired-unswept', () => {
    assert.equal(coverageTotal({pending: 1, expiredUnswept: 5, observed: 2, unavailable: 3, missed: 4}), 15);
  });
  test('zero coverage is labeled honestly, not as a report with zero return', () => {
    assert.equal(coverageLabel({pending: 0, expiredUnswept: 0, observed: 0, unavailable: 0, missed: 0}), 'No outcomes recorded yet.');
  });
  test('a populated bucket reports every status, not only observed', () => {
    assert.equal(coverageLabel({pending: 1, expiredUnswept: 0, observed: 2, unavailable: 0, missed: 1}), '2/4 observed, 1 pending, 0 unavailable, 1 missed.');
  });

  // Stage 06: a closed window with nothing recorded is not work still to come, and the label must never let
  // it be read as such.
  test('expired-unswept rows are named separately from live pending, and never added to it', () => {
    const label = coverageLabel({pending: 1, expiredUnswept: 3, observed: 2, unavailable: 0, missed: 1});
    assert.match(label, /1 pending/);
    assert.match(label, /3 expired-unswept \(window closed, not live pending\)/);
    assert.doesNotMatch(label, /4 pending/, 'expired-unswept must never be folded into the pending count');
  });
  test('the expired-unswept clause is omitted entirely when there are none', () => {
    assert.doesNotMatch(coverageLabel({pending: 1, expiredUnswept: 0, observed: 2, unavailable: 0, missed: 1}), /expired/);
  });
  test('the total counts expired-unswept rows, so no row silently leaves the denominator', () => {
    assert.match(coverageLabel({pending: 0, expiredUnswept: 4, observed: 1, unavailable: 0, missed: 0}), /^1\/5 observed/);
  });
});

// --- Stage 06: cadence honesty -------------------------------------------------------------------------

describe('cadenceSummary', () => {
  const cadence = cadenceReport();

  test('states the once-daily cadence, the maximum gap and the grace window', () => {
    const summary = cadenceSummary(cadence);
    assert.match(summary, /scans once a day/);
    assert.match(summary, /0 0 \* \* \*/);
    assert.match(summary, /up to 25\.0h between two runs/, 'the 24h59m maximum gap, rounded for display');
    assert.match(summary, /26h grace window/);
  });

  test('says the active horizons are targets observed at the next daily scan, not exact-time prices', () => {
    const summary = cadenceSummary(cadence);
    assert.match(summary, /first daily scan at or after its target age/);
    assert.match(summary, /not exact-time execution prices/);
    assert.match(summary, /how long after detection the price was actually read/);
  });

  test('degrades to the built-in constants rather than crashing when the report has no cadence block', () => {
    assert.match(cadenceSummary(null), /scans once a day/);
  });
});

describe('unobservableHorizons / legacyHorizonWarning', () => {
  const cadence = cadenceReport();

  test('names every legacy intraday horizon, including the 6h one the old documentation omitted', () => {
    assert.deepEqual(unobservableHorizons(cadence).map(h => h.id), ['15m', '1h', '6h', '24h']);
    const warning = legacyHorizonWarning(cadence);
    assert.match(warning, /15m, 1h, 6h, 24h/);
    assert.match(warning, /cannot be evaluated by a once-daily scan/);
    assert.match(warning, /narrower than the 25\.0h maximum gap/);
  });

  test('says their missed counts describe the schedule, and that no new signal is given one', () => {
    const warning = legacyHorizonWarning(cadence);
    assert.match(warning, /describe the schedule that recorded them, not the tokens/);
    assert.match(warning, /No new signal is given one/);
  });

  test('never claims an active horizon is unobservable', () => {
    for (const horizon of unobservableHorizons(cadence)) assert.equal(horizon.active, false);
  });

  test('is empty when every horizon in the report is observable', () => {
    const observableOnly = {...cadence, horizons: cadence.horizons.filter(h => h.observableUnderCadence)};
    assert.deepEqual(unobservableHorizons(observableOnly).map(h => h.id), []);
    assert.equal(legacyHorizonWarning(observableOnly), '');
    assert.equal(legacyHorizonWarning(null), '');
  });
});

describe('observedAfterLabel', () => {
  test('reports the real elapsed time after detection, never the target age', () => {
    assert.equal(observedAfterLabel({count: 3, mean: 47.2, median: 47.2, stdev: 1}), '47.2h after detection');
  });
  test('names the median too when it differs from the mean', () => {
    assert.equal(observedAfterLabel({count: 4, mean: 36, median: 24.5, stdev: 12}), '36.0h after detection, median 24.5h');
  });
  test('an empty sample is a dash, never 0h', () => {
    assert.equal(observedAfterLabel({count: 0, mean: null, median: null, stdev: null}), '—');
    assert.equal(observedAfterLabel({count: 2, mean: null, median: null, stdev: null}), '—');
  });
});

describe('horizonLabel / horizonScheduleNote', () => {
  const facts = (overrides = {}) => ({horizon: 'd1', horizonLabel: '1-day target', horizonSchedule: 'daily-snapshot-v1', horizonActive: true, observableUnderCadence: true, targetHours: 24, ...overrides});

  test('an active, observable horizon is labeled as an active daily snapshot', () => {
    assert.equal(horizonLabel(facts()), '1-day target');
    assert.equal(horizonScheduleNote(facts()), 'active daily snapshot');
  });
  test('a legacy horizon says it is legacy and not observable on this cadence', () => {
    const legacy = facts({horizon: '24h', horizonLabel: '24h (legacy)', horizonSchedule: 'intraday-v0', horizonActive: false, observableUnderCadence: false});
    assert.equal(horizonLabel(legacy), '24h (legacy)');
    assert.equal(horizonScheduleNote(legacy), 'legacy, not observable on this cadence');
  });
  test('falls back to the raw id for a horizon with no definition, never inventing a label', () => {
    assert.equal(horizonLabel({horizon: 'mystery', horizonLabel: '', horizonSchedule: null, horizonActive: false, observableUnderCadence: false, targetHours: null}), 'mystery');
  });
});

describe('allHistoryOpportunityLabel', () => {
  test('zero opportunities across a populated history is stated plainly as a result', () => {
    const label = allHistoryOpportunityLabel({signals: 87, opportunities: 0, control: 60, strategy: 27});
    assert.match(label, /^0 opportunities across all 87 recorded signals/);
    assert.match(label, /That is a result, not missing data/);
  });
  test('an empty history says so, and still reports 0 rather than nothing', () => {
    assert.match(allHistoryOpportunityLabel({signals: 0, opportunities: 0, control: 0, strategy: 0}), /Across all recorded history: 0 signals, and so 0 opportunities./);
    // Never the sentence the most-recent-batch line already owns, so the two stay distinguishable.
    assert.doesNotMatch(allHistoryOpportunityLabel({signals: 0, opportunities: 0, control: 0, strategy: 0}), /No signals have been recorded yet/);
  });
  test('a populated count reads naturally, singular and plural', () => {
    assert.match(allHistoryOpportunityLabel({signals: 87, opportunities: 1, control: 60, strategy: 27}), /^1 opportunity across all 87 recorded signals/);
    assert.match(allHistoryOpportunityLabel({signals: 87, opportunities: 5, control: 60, strategy: 27}), /^5 opportunities across all 87 recorded signals/);
  });
  test('null totals render nothing rather than a guess', () => assert.equal(allHistoryOpportunityLabel(null), ''));
});

describe('denominatorNote', () => {
  const totals = {signals: 90, opportunities: 2, control: 60, strategy: 30};
  const group = (signals, observedReturns) => ({signals, coverage: {pending: 0, expiredUnswept: 0, observed: observedReturns, unavailable: 0, missed: 0}, observedReturns});
  const denominators = {control: group(60, 40), strategy: group(30, 12), opportunity: group(2, 2)};

  test('names the control and strategy denominators separately and never adds them', () => {
    const note = denominatorNote(totals, denominators);
    assert.match(note, /Separate denominators, never combined/);
    assert.match(note, /60 REJECTED control signals \(40 observed returns\)/);
    assert.match(note, /30 actionable-state signals \(12 observed\)/);
    assert.match(note, /2 were opportunities \(2 observed\)/);
    assert.doesNotMatch(note, /52 observed/, 'the control and strategy observed counts must never be summed');
  });

  test('says explicitly that a REJECTED observation is not evidence about the strategy', () => {
    assert.match(denominatorNote(totals, denominators), /says nothing about how the candidates that cleared every gate performed/);
  });

  test('renders nothing when either input is missing, rather than a partial claim', () => {
    assert.equal(denominatorNote(null, denominators), '');
    assert.equal(denominatorNote(totals, null), '');
  });
});

describe('hasDataQualityWarning / dataQualityWarning (truncation and malformed-data visibility)', () => {
  const clean = {totalSignals: 20, truncated: false, skippedMalformedRows: 0, skippedMalformedOutcomes: 0};

  test('null report: no warning', () => assert.equal(hasDataQualityWarning(null), false));
  test('a clean report: no warning', () => {
    assert.equal(hasDataQualityWarning(clean), false);
    assert.equal(dataQualityWarning(clean), '');
  });
  test('truncated: true triggers a warning that states the analysis is partial and how many rows were analyzed', () => {
    const report = {...clean, truncated: true};
    assert.equal(hasDataQualityWarning(report), true);
    const warning = dataQualityWarning(report);
    assert.match(warning, /Partial analysis/);
    assert.match(warning, /20/);
    assert.match(warning, /newest valid signals/, 'must say the newest part of history was retained, not silently imply completeness');
  });
  test('skippedMalformedRows > 0 triggers a warning naming the excluded row count', () => {
    const report = {...clean, skippedMalformedRows: 3};
    assert.equal(hasDataQualityWarning(report), true);
    assert.match(dataQualityWarning(report), /3 stored signal rows failed validation/);
  });
  test('skippedMalformedOutcomes > 0 triggers a warning naming the excluded outcome count', () => {
    const report = {...clean, skippedMalformedOutcomes: 5};
    assert.equal(hasDataQualityWarning(report), true);
    assert.match(dataQualityWarning(report), /5 stored outcome rows failed validation/);
  });
  test('a report must never show an unqualified "N signals recorded" style total when truncated', () => {
    const warning = dataQualityWarning({...clean, totalSignals: 20000, truncated: true});
    assert.doesNotMatch(warning, /^20000 signals recorded\.?$/, 'a truncated total must be qualified as partial, not stated as if complete');
  });
});

describe('signalsSummaryLabel (Opus nit: the main summary must never say a bare "N signals recorded" when truncated)', () => {
  test('null report: empty string', () => assert.equal(signalsSummaryLabel(null), ''));
  test('non-truncated: simple wording, "valid signals analyzed"', () => {
    assert.equal(signalsSummaryLabel({totalSignals: 20, truncated: false}), '20 valid signals analyzed.');
  });
  test('truncated: names the bounded history explicitly, never bare "signals recorded"', () => {
    const label = signalsSummaryLabel({totalSignals: 2000, truncated: true});
    assert.equal(label, '2000 newest valid signals analyzed from the bounded history.');
    assert.doesNotMatch(label, /recorded/, 'a truncated total must never read as "recorded" (implying the complete stored history)');
  });
});

describe('cellStatusLabel', () => {
  test('sufficient has no label (nothing to warn about)', () => assert.equal(cellStatusLabel('sufficient'), ''));
  test('insufficient is labeled honestly', () => assert.equal(cellStatusLabel('insufficient'), 'insufficient evidence'));
  test('not_evaluable is labeled distinctly from insufficient', () => {
    const label = cellStatusLabel('not_evaluable');
    assert.notEqual(label, '');
    assert.notEqual(label, cellStatusLabel('insufficient'));
  });
});
