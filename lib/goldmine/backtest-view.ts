// Pure view logic for the Goldmine "Backtesting & Calibration" dashboard section (app/goldmine-panel.tsx),
// kept separate from JSX for direct node:test coverage, the same pattern as dashboard-view.ts. Nothing
// here recomputes a score, calls a provider or decides what is an opportunity: it only classifies the
// already-computed report GET /api/goldmine/backtest returns.
export type Distribution = {count: number; mean: number | null; median: number | null; stdev: number | null};
export type OutcomeCoverage = {pending: number; observed: number; unavailable: number; missed: number};
export type PerformanceBucket = {modelVersion: string; state: string; horizon: string; coverage: OutcomeCoverage; returnsPct: Distribution; positiveShare: number | null};
export type CalibrationHorizonRow = {
  horizon: string;
  eligible: number;
  coverage: OutcomeCoverage;
  coverageRatio: number | null;
  eligibleWithOutcome: number;
  returnsPct: Distribution;
  positiveShare: number | null;
  sufficientEvidence: boolean;
};
export type CalibrationRow = {threshold: number; eligibleCount: number; byHorizon: CalibrationHorizonRow[]};
export type CalibrationResult = {
  modelVersion: string;
  excludedOtherVersionSignals: number;
  cutoffAt: number;
  referenceCount: number;
  evaluationCount: number;
  descriptiveOnly: boolean;
  rows: CalibrationRow[];
};
export type BacktestReport = {
  modelVersion: string;
  totalSignals: number;
  skippedMalformedRows: number;
  truncated: boolean;
  replay: {currentVersionSignals: number; matched: number; mismatched: {signalId: string; address: string}[]; unsupportedCount: number; unsupportedModelVersions: string[]};
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
