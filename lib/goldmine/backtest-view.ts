// Pure view logic for the Goldmine "Backtesting & Calibration" dashboard section (app/goldmine-panel.tsx),
// kept separate from JSX for direct node:test coverage, the same pattern as dashboard-view.ts. Nothing
// here recomputes a score, calls a provider or decides what is an opportunity: it only classifies the
// already-computed report GET /api/goldmine/backtest returns.
//
// The cadence facts it needs come from lib/goldmine/cadence.ts, the same module the API and the database
// writer use, so a threshold or horizon definition is never restated here in a second place where it could
// drift out of agreement with what was actually recorded.
import {
  coverageTotal as coverageTotalOf, hoursOf, MAX_SCAN_GAP_MS, OBSERVATION_GRACE_MS, SCAN_CADENCE_MS,
  SCAN_CRON_EXPRESSION, type CadenceReport, type HorizonReport, type OutcomeCoverage,
} from './cadence';

export type {CadenceReport, HorizonReport, OutcomeCoverage};
export type Distribution = {count: number; mean: number | null; median: number | null; stdev: number | null};
export type HorizonFacts = {
  horizonLabel: string;
  horizonSchedule: string | null;
  horizonActive: boolean;
  observableUnderCadence: boolean;
  targetHours: number | null;
};
export type PerformanceBucket = HorizonFacts & {
  modelVersion: string; state: string; horizon: string; coverage: OutcomeCoverage;
  returnsPct: Distribution; positiveShare: number | null; observedAfterHours: Distribution;
};
export type CellEvidenceStatus = 'sufficient' | 'insufficient' | 'not_evaluable';
export type CalibrationHorizonRow = HorizonFacts & {
  horizon: string;
  eligible: number;
  coverage: OutcomeCoverage;
  coverageRatio: number | null;
  eligibleWithOutcome: number;
  returnsPct: Distribution;
  positiveShare: number | null;
  cellStatus: CellEvidenceStatus;
  sufficientEvidence: boolean;
  observedAfterHours: Distribution;
};
export type CalibrationRow = {threshold: number; eligibleCount: number; byHorizon: CalibrationHorizonRow[]};
export type CalibrationResult = {
  modelVersion: string;
  excludedOtherVersionSignals: number;
  cutoffAt: number;
  referenceCount: number;
  evaluationCount: number;
  sufficientCellCount: number;
  insufficientCellCount: number;
  notEvaluableCellCount: number;
  totalCellCount: number;
  descriptiveOnly: boolean;
  rows: CalibrationRow[];
};
export type DenominatorGroup = {signals: number; coverage: OutcomeCoverage; observedReturns: number};
export type DenominatorSplit = {control: DenominatorGroup; strategy: DenominatorGroup; opportunity: DenominatorGroup};
export type SignalTotals = {signals: number; opportunities: number; control: number; strategy: number};
// Mirrors lib/goldmine/backtest.ts ReportCoverage (the API's `coverage`).
export type ReportCoverage = {
  signalsAnalyzed: number; storedSignals: number; truncated: boolean;
  oldestAnalyzedAt: number | null; newestAnalyzedAt: number | null;
  targetWindowDays: number; targetWindowFullyAnalyzed: boolean;
};
export type BacktestReport = {
  modelVersion: string;
  evaluationScheduleVersion: string;
  cadence: CadenceReport;
  generatedAt: number;
  totalSignals: number;
  totals: SignalTotals;
  denominators: DenominatorSplit;
  skippedMalformedRows: number;
  skippedMalformedOutcomes: number;
  truncated: boolean;
  coverage: ReportCoverage;
  replay: {
    currentVersionSignals: number;
    matched: number;
    mismatchedCount: number;
    mismatchedSample: {signalId: string; address: string}[];
    mismatchedSampleTruncated: boolean;
    unsupportedCount: number;
    unsupportedModelVersions: string[];
    invalidCount: number;
  };
  performance: PerformanceBucket[];
  calibration: CalibrationResult | null;
  limitations: string[];
  disclaimer: string;
};

// Below this many recorded signals, the section shows an honest "not enough data yet" message rather than
// a report built from a handful of rows that would look like a real distribution but is not one.
export const MIN_SIGNALS_FOR_REPORT = 10;

export function hasEnoughData(report: {totalSignals: number} | null): boolean {
  return report !== null && report.totalSignals >= MIN_SIGNALS_FOR_REPORT;
}

// Only buckets with at least one observed outcome are worth a row: an all-pending/unavailable/missed
// bucket is real information (shown in the coverage summary), but plotting a return distribution with
// zero samples would misrepresent it as a measured result.
export function performanceRowsWithData(performance: PerformanceBucket[]): PerformanceBucket[] {
  return performance.filter(bucket => bucket.returnsPct.count > 0 || coverageTotal(bucket.coverage) > 0);
}

export function coverageTotal(coverage: OutcomeCoverage): number {
  return coverageTotalOf(coverage);
}

// A one-line, honest summary of how much of a bucket's outcomes are actually observed returns, so the
// dashboard never implies more certainty than the coverage supports. `pending` and `expired-unswept` are
// named separately and never added together: the first is work genuinely still to come, the second is a
// window that has already closed with nothing recorded and simply has not been swept to `missed` yet.
export function coverageLabel(coverage: OutcomeCoverage): string {
  const total = coverageTotal(coverage);
  if (!total) return 'No outcomes recorded yet.';
  const parts = [`${coverage.observed}/${total} observed`, `${coverage.pending} pending`];
  if (coverage.expiredUnswept > 0) parts.push(`${coverage.expiredUnswept} expired-unswept (window closed, not live pending)`);
  parts.push(`${coverage.unavailable} unavailable`, `${coverage.missed} missed`);
  return parts.join(', ') + '.';
}

// Whether the dashboard must show a data-quality warning: any of a bounded/partial read, or rows/outcomes
// excluded for failing structural validation. `totalSignals` alone (e.g. "20,000 signals recorded") must
// never be shown as if it were the complete stored history when any of these is true.
export function hasDataQualityWarning(report: {truncated: boolean; skippedMalformedRows: number; skippedMalformedOutcomes: number} | null): boolean {
  return report !== null && (report.truncated || report.skippedMalformedRows > 0 || report.skippedMalformedOutcomes > 0);
}

// An explicit, honest statement of what the report below does and does not cover: whether the analysis is
// partial, how many rows were actually analyzed, whether malformed data was excluded (and how much), and -
// when truncated - which part of history was retained (the most recently detected signals, never the
// oldest). Returns '' when there is nothing to warn about.
export function dataQualityWarning(report: {totalSignals: number; truncated: boolean; skippedMalformedRows: number; skippedMalformedOutcomes: number} | null): string {
  if (!hasDataQualityWarning(report) || !report) return '';
  const parts: string[] = [];
  parts.push(report.truncated
    ? `Partial analysis: only the ${report.totalSignals} newest valid signals within this request's bound were analyzed, not the full stored history.`
    : `${report.totalSignals} valid signals analyzed.`);
  if (report.skippedMalformedRows > 0) parts.push(`${report.skippedMalformedRows} stored signal row${report.skippedMalformedRows === 1 ? '' : 's'} failed validation and ${report.skippedMalformedRows === 1 ? 'was' : 'were'} excluded.`);
  if (report.skippedMalformedOutcomes > 0) parts.push(`${report.skippedMalformedOutcomes} stored outcome row${report.skippedMalformedOutcomes === 1 ? '' : 's'} failed validation and ${report.skippedMalformedOutcomes === 1 ? 'was' : 'were'} excluded.`);
  return parts.join(' ');
}

// The main report body's own truthful summary of how many signals it covers - distinct from, and shown
// alongside, dataQualityWarning above. Never says "N signals recorded" for a truncated read: `totalSignals`
// is always the count of valid rows this request actually analyzed (after excluding malformed rows and
// applying the read bound), never a claim about how many rows are stored in total. A truncated read is
// called out here too (not only in the data-quality banner) so this line can never read as if it covered
// the complete stored history while a truncation banner sits right above it saying otherwise.
export function signalsSummaryLabel(report: {totalSignals: number; truncated: boolean} | null): string {
  if (!report) return '';
  return report.truncated
    ? `${report.totalSignals} newest valid signals analyzed from the bounded history.`
    : `${report.totalSignals} valid signals analyzed.`;
}

// The exact window the report covers, in UTC, always shown with the report. States the detection-time span
// of the rows actually analyzed, how many of the stored signals that is, and whether the 30-day research
// target was reached - so a bounded read is never taken for "30 days" or "all history".
const utc = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
function span(ms: number): string {
  const days = ms / (24 * 3600000);
  if (days >= 1) return `${days.toFixed(1)} days`;
  const h = ms / 3600000;
  return `${h.toFixed(1)} hours`;
}

export function coverageWindowLabel(coverage: ReportCoverage | null | undefined): string {
  if (!coverage || coverage.oldestAnalyzedAt === null || coverage.newestAnalyzedAt === null) return '';
  const window = `detected ${utc(coverage.oldestAnalyzedAt)} to ${utc(coverage.newestAnalyzedAt)} (${span(coverage.newestAnalyzedAt - coverage.oldestAnalyzedAt)})`;
  const target = `${coverage.targetWindowDays}-day research target`;
  if (!coverage.truncated) {
    return `Covers ${coverage.signalsAnalyzed} of ${coverage.storedSignals} stored signals, ${window}. Nothing was cut off by the read bound${coverage.newestAnalyzedAt - coverage.oldestAnalyzedAt < coverage.targetWindowDays * 24 * 3600000 ? `; the stored history is shorter than the ${target}` : ''}.`;
  }
  return `Covers only the newest ${coverage.signalsAnalyzed} of ${coverage.storedSignals} stored signals, ${window}. ${coverage.targetWindowFullyAnalyzed
    ? `Every signal from the ${target} window is included; older stored signals are not.`
    : `This is less than the ${target}: older stored signals were not read and are not reflected in this report.`}`;
}

// A short, honest label for a calibration cell's evidence status - never implies a claim the cell's own
// sample cannot support, and never borrows credibility from a sibling cell.
export function cellStatusLabel(status: CellEvidenceStatus): string {
  if (status === 'sufficient') return '';
  if (status === 'not_evaluable') return 'no eligible signals';
  return 'insufficient evidence';
}

// --- Stage 06: cadence honesty -----------------------------------------------------------------------

const hours = (ms: number) => {
  const value = hoursOf(ms) ?? 0;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
};

// The standing explanation of what this deployment's schedule can and cannot measure. Shown whenever the
// section renders - not only once there is enough data - because it is exactly the fact that makes a
// mostly-`missed` legacy column legible instead of looking like a broken scanner.
export function cadenceSummary(cadence: CadenceReport | null): string {
  const scanCadence = cadence?.scanCadenceMs ?? SCAN_CADENCE_MS;
  const maxGap = cadence?.maxScanGapMs ?? MAX_SCAN_GAP_MS;
  const grace = cadence?.observationGraceMs ?? OBSERVATION_GRACE_MS;
  const cron = cadence?.cronExpression ?? SCAN_CRON_EXPRESSION;
  return `Outcomes are only ever observed when a scan runs, and this deployment scans once a day (${cron}, every ${hours(scanCadence)}h, up to ${hours(maxGap)}h between two runs). `
    + `Active horizons are daily snapshots: each is observed at the first daily scan at or after its target age, inside a ${hours(grace)}h grace window wide enough that a scan is guaranteed to fall in it. `
    + 'They are targets, not exact-time execution prices - every observation below reports how long after detection the price was actually read.';
}

// The legacy horizons the current cadence cannot evaluate, named explicitly. A horizon is listed when its
// grace window is narrower than the widest gap between two scans, which is the same single inequality the
// API derives (lib/goldmine/cadence.ts isObservableUnderCadence) - not a hardcoded list of ids.
export function unobservableHorizons(cadence: CadenceReport | null): HorizonReport[] {
  return (cadence?.horizons ?? []).filter(horizon => !horizon.observableUnderCadence);
}

// '' when every horizon in the report is observable. Otherwise says plainly that these columns cannot be
// evaluated on this cadence and that their `missed` counts are a property of the schedule, not a result.
export function legacyHorizonWarning(cadence: CadenceReport | null): string {
  const unobservable = unobservableHorizons(cadence);
  if (!unobservable.length) return '';
  const names = unobservable.map(horizon => horizon.id).join(', ');
  const maxGap = hours(cadence?.maxScanGapMs ?? MAX_SCAN_GAP_MS);
  return `Legacy intraday horizons (${names}) cannot be evaluated by a once-daily scan: every one of their observation windows is narrower than the ${maxGap}h maximum gap between two scans, so no scan is guaranteed to fall inside one. `
    + 'They are kept because they exist in recorded history; their missed counts describe the schedule that recorded them, not the tokens. No new signal is given one.';
}

// How long after detection a price was actually read, as a label. Never claims the target age: on a daily
// cadence an observation legitimately lands at the target or about a day later, and this is the only place
// the difference is visible.
export function observedAfterLabel(distribution: Distribution): string {
  if (!distribution.count) return '—';
  const mean = distribution.mean;
  if (mean === null) return '—';
  const spread = distribution.count > 1 && distribution.median !== null && distribution.median !== mean
    ? `, median ${distribution.median.toFixed(1)}h` : '';
  return `${mean.toFixed(1)}h after detection${spread}`;
}

// One row's horizon, labeled with the schedule it belongs to, so an active daily snapshot and a legacy
// intraday row are never rendered as though they were the same kind of measurement.
export function horizonLabel(row: HorizonFacts & {horizon: string}): string {
  return row.horizonLabel || row.horizon;
}

export function horizonScheduleNote(row: HorizonFacts): string {
  if (row.horizonActive) return row.observableUnderCadence ? 'active daily snapshot' : 'active, but not observable on this cadence';
  return row.observableUnderCadence ? 'legacy schedule' : 'legacy, not observable on this cadence';
}

// Every opportunity ever recorded, across all of stored history - not "within this request's read bound".
// Zero is stated as a result in plain words, never left to read as missing data.
export function allHistoryOpportunityLabel(totals: SignalTotals | null): string {
  if (!totals) return '';
  // Deliberately not worded as "no signals have been recorded yet": that sentence already belongs to the
  // most-recent-batch line above the section (lib/goldmine/dashboard-view.ts latestBatchCountsLabel), and
  // two different statements reading identically is how a reader stops being able to tell them apart.
  if (totals.signals === 0) return 'Across all recorded history: 0 signals, and so 0 opportunities.';
  if (totals.opportunities === 0) {
    return `0 opportunities across all ${totals.signals} recorded signals: nothing has ever cleared every safety and momentum gate on this deployment. That is a result, not missing data.`;
  }
  return `${totals.opportunities} opportunit${totals.opportunities === 1 ? 'y' : 'ies'} across all ${totals.signals} recorded signals.`;
}

// The control group stated as a control group. REJECTED signals are recorded on purpose - something has to
// be compared against - but their observations are never evidence about the strategy, and they never share
// a denominator with it.
export function denominatorNote(totals: SignalTotals | null, denominators: DenominatorSplit | null): string {
  if (!totals || !denominators) return '';
  return `Separate denominators, never combined: ${totals.control} REJECTED control signals (${denominators.control.observedReturns} observed return${denominators.control.observedReturns === 1 ? '' : 's'}) versus `
    + `${totals.strategy} actionable-state signals (${denominators.strategy.observedReturns} observed) of which ${totals.opportunities} were opportunities (${denominators.opportunity.observedReturns} observed). `
    + 'A REJECTED observation is a control measurement: it says nothing about how the candidates that cleared every gate performed, and is never added to their numbers.';
}
