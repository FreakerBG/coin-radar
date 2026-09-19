// Pure view logic for the Goldmine "Backtesting & Calibration" dashboard section (app/goldmine-panel.tsx),
// kept separate from JSX for direct node:test coverage, the same pattern as dashboard-view.ts. Nothing
// here recomputes a score, calls a provider or decides what is an opportunity: it only classifies the
// already-computed report GET /api/goldmine/backtest returns.
export type Distribution = {count: number; mean: number | null; median: number | null; stdev: number | null};
export type OutcomeCoverage = {pending: number; observed: number; unavailable: number; missed: number};
export type PerformanceBucket = {modelVersion: string; state: string; horizon: string; coverage: OutcomeCoverage; returnsPct: Distribution; positiveShare: number | null};
export type CellEvidenceStatus = 'sufficient' | 'insufficient' | 'not_evaluable';
export type CalibrationHorizonRow = {
  horizon: string;
  eligible: number;
  coverage: OutcomeCoverage;
  coverageRatio: number | null;
  eligibleWithOutcome: number;
  returnsPct: Distribution;
  positiveShare: number | null;
  cellStatus: CellEvidenceStatus;
  sufficientEvidence: boolean;
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
export type BacktestReport = {
  modelVersion: string;
  totalSignals: number;
  skippedMalformedRows: number;
  skippedMalformedOutcomes: number;
  truncated: boolean;
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
  return performance.filter(bucket => bucket.returnsPct.count > 0 || bucket.coverage.pending + bucket.coverage.observed + bucket.coverage.unavailable + bucket.coverage.missed > 0);
}

export function coverageTotal(coverage: OutcomeCoverage): number {
  return coverage.pending + coverage.observed + coverage.unavailable + coverage.missed;
}

// A one-line, honest summary of how much of a bucket's outcomes are actually observed returns, so the
// dashboard never implies more certainty than the coverage supports.
export function coverageLabel(coverage: OutcomeCoverage): string {
  const total = coverageTotal(coverage);
  if (!total) return 'No outcomes recorded yet.';
  return `${coverage.observed}/${total} observed, ${coverage.pending} pending, ${coverage.unavailable} unavailable, ${coverage.missed} missed.`;
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
    ? `Partial analysis: only the ${report.totalSignals} most recently detected signals within this request's bound were analyzed, not the full stored history.`
    : `${report.totalSignals} signals analyzed.`);
  if (report.skippedMalformedRows > 0) parts.push(`${report.skippedMalformedRows} stored signal row${report.skippedMalformedRows === 1 ? '' : 's'} failed validation and ${report.skippedMalformedRows === 1 ? 'was' : 'were'} excluded.`);
  if (report.skippedMalformedOutcomes > 0) parts.push(`${report.skippedMalformedOutcomes} stored outcome row${report.skippedMalformedOutcomes === 1 ? '' : 's'} failed validation and ${report.skippedMalformedOutcomes === 1 ? 'was' : 'were'} excluded.`);
  return parts.join(' ');
}

// A short, honest label for a calibration cell's evidence status - never implies a claim the cell's own
// sample cannot support, and never borrows credibility from a sibling cell.
export function cellStatusLabel(status: 'sufficient' | 'insufficient' | 'not_evaluable'): string {
  if (status === 'sufficient') return '';
  if (status === 'not_evaluable') return 'no eligible signals';
  return 'insufficient evidence';
}
