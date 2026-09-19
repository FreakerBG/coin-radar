// Goldmine backtesting and calibration (Stage 03D): read-only diagnostics over already-stored
// goldmine_signals/goldmine_outcomes rows. Nothing here calls a provider, mutates a stored row or changes
// live scoring - it only recomputes and aggregates what scoreCandidate (lib/goldmine/score.ts) and
// evaluateOutcomes (lib/goldmine/signals.ts) already produced and recorded.
//
// Historical replay is directly supported only for a signal whose stored model_version equals the
// current MODEL_VERSION: scoreCandidate is a pure function of the stored snapshot, so recomputing it must
// reproduce the stored assessment exactly (a determinism/audit check, and the mechanism a future
// v2.2.0+ would use to re-score v2.1.0 history once it exists). A signal recorded under any other
// model_version has no implementation of that version in this codebase; it is never run through the
// current scoreCandidate and relabeled as its historical result - it is marked unsupported instead.
import {HORIZONS, type StoredOutcomeRow, type StoredSignalRow} from './signals';
import {MODEL_VERSION, scoreCandidate, type Assessment} from './score';

// This is a research/diagnostic tool, not a forecast: nothing here claims predictive accuracy or
// profitability, and every report should be read together with these limitations.
export const BACKTEST_LIMITATIONS = [
  'Discovery covers at most 30 recently profiled or promoted Solana tokens per scan, not the whole market: stored signals are a sample of what was scanned, never exhaustive historical coverage, and are biased toward whatever DEX Screener profiled or promoted.',
  'The detection price is a DEX Screener quote at scan time, not an executable price; realized returns below ignore fees, slippage and price impact.',
  'Only momentum-v2.1.0 has an implementation in this codebase. Signals recorded under a different stored model_version show their original stored assessment only; there is no supported replay for them here.',
  'Outcome coverage (pending/unavailable/missed) is reported next to observed returns, never dropped from the denominator or treated as a zero return - a state with mostly missed or unavailable outcomes has little realized evidence regardless of its observed mean.',
  'The calibration threshold sweep is descriptive only: candidate thresholds are fixed, never chosen or searched for to fit this data, and it is calibrated on the current model version alone - signals from any other stored model_version are excluded, never reinterpreted under these thresholds.',
  'Evidence sufficiency is judged per threshold/horizon cell, from the actual observed returns used in that cell\'s distribution, not from how many signals were evaluated: descriptiveOnly stays true unless every reported, evaluable cell (one with at least one eligible signal) individually meets the observed-return requirement - one strong cell can never make the whole result read as validated.',
  'Samples are not statistically independent: the same token can be recorded again in a later scan, and one signal contributes to up to four overlapping horizon buckets (15m/1h/6h/24h) at once. Treat every mean, median and stdev here as descriptive of this recorded history, not as an estimate from independent trials - and treat any mean computed from a single observed return (n=1) as a single data point, not a statistic.',
  'History is read newest-first and bounded per request; if `truncated` is true, only the most recently detected signals within that bound are reflected below, not the full stored history. Rows or outcomes that fail structural validation are excluded and counted (skippedMalformedRows/skippedMalformedOutcomes), never guessed at or silently folded into any status.',
];

// --- Historical replay ------------------------------------------------------------------------------

export type ReplaySupported = {supported: true; signalId: string; modelVersion: string; matchesStored: boolean; recomputed: Assessment};
export type ReplayUnsupported = {supported: false; signalId: string; modelVersion: string; reason: string; invalid?: false};
// A signal stored under the current MODEL_VERSION whose snapshot passed structural validation
// (isValidStoredSnapshot) but still made scoreCandidate throw - defense-in-depth against any input shape
// validation did not anticipate. Skipped and counted like any other malformed row, never allowed to fail
// the whole report with a 503.
export type ReplayInvalid = {supported: false; signalId: string; modelVersion: string; reason: string; invalid: true};
export type ReplayResult = ReplaySupported | ReplayUnsupported | ReplayInvalid;

export function replaySignal(signal: StoredSignalRow): ReplayResult {
  if (signal.modelVersion !== MODEL_VERSION) {
    return {
      supported: false,
      signalId: signal.id,
      modelVersion: signal.modelVersion,
      reason: `No implementation of model version ${signal.modelVersion} exists in this codebase (current: ${MODEL_VERSION}). Original stored assessment only; no supported replay.`,
    };
  }
  try {
    const recomputed = scoreCandidate(signal.snapshot);
    return {supported: true, signalId: signal.id, modelVersion: signal.modelVersion, matchesStored: deepEqual(recomputed, signal.assessment), recomputed};
  } catch {
    // Structural validation (isValidStoredSnapshot) already rejects every shape known to make
    // scoreCandidate throw; this catch is defense-in-depth for the unknown case, so one unexpected bad
    // historical row is skipped and counted rather than throwing out of replayAll and failing the whole
    // GET /api/goldmine/backtest report for every other signal.
    return {supported: false, signalId: signal.id, modelVersion: signal.modelVersion, reason: 'Stored snapshot failed replay scoring; row skipped.', invalid: true};
  }
}

// A small, deterministic sample of mismatched signal ids/addresses to return from the API - never the
// full list, which is unbounded by the size of stored history. `mismatchedCount` is always the true total;
// `mismatchedSampleTruncated` says whether the sample below is a subset of it.
export const MISMATCHED_SAMPLE_LIMIT = 20;

export type ReplaySummary = {
  totalSignals: number;
  currentVersionSignals: number;
  matched: number;
  mismatchedCount: number;
  mismatchedSample: {signalId: string; address: string}[];
  mismatchedSampleTruncated: boolean;
  unsupportedModelVersions: string[];
  unsupportedCount: number;
  // Rows that matched the current model version and passed structural validation, but still failed replay
  // scoring for an unanticipated reason (see ReplayInvalid). Included in `unsupportedCount`/
  // `currentVersionSignals` accounting is deliberately kept separate: invalidCount is never silently
  // folded into "no implementation of this model version" (unsupportedModelVersions), which would be a
  // different and misleading reason.
  invalidCount: number;
};

// Replays every signal and summarizes the result. Never mutates the input rows; each ReplayResult is a
// freshly computed value, and the stored assessment is only read for comparison, never written back.
export function replayAll(signals: StoredSignalRow[]): ReplaySummary {
  const byId = new Map(signals.map(signal => [signal.id, signal]));
  const results = signals.map(replaySignal);
  const supported = results.filter((result): result is ReplaySupported => result.supported);
  const unsupported = results.filter((result): result is ReplayUnsupported | ReplayInvalid => !result.supported);
  const invalid = unsupported.filter((result): result is ReplayInvalid => result.invalid === true);
  const versionUnsupported = unsupported.filter(result => result.invalid !== true);
  const mismatched = supported.filter(result => !result.matchesStored)
    .map(result => ({signalId: result.signalId, address: byId.get(result.signalId)?.address ?? ''}));
  return {
    totalSignals: signals.length,
    currentVersionSignals: supported.length,
    matched: supported.length - mismatched.length,
    mismatchedCount: mismatched.length,
    mismatchedSample: mismatched.slice(0, MISMATCHED_SAMPLE_LIMIT),
    mismatchedSampleTruncated: mismatched.length > MISMATCHED_SAMPLE_LIMIT,
    unsupportedModelVersions: [...new Set(versionUnsupported.map(result => result.modelVersion))].sort(),
    unsupportedCount: versionUnsupported.length,
    invalidCount: invalid.length,
  };
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// --- Distribution stats ------------------------------------------------------------------------------

export type Distribution = {count: number; mean: number | null; median: number | null; stdev: number | null};

const round = (value: number, digits = 4) => Number(value.toFixed(digits));

// Sample mean, median and sample standard deviation (n-1 divisor). stdev is null with fewer than two
// values - not zero, which would misrepresent a single observation as having no spread.
export function distribution(values: number[]): Distribution {
  const count = values.length;
  if (!count) return {count: 0, mean: null, median: null, stdev: null};
  const mean = values.reduce((sum, value) => sum + value, 0) / count;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(count / 2);
  const median = count % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const stdev = count > 1 ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (count - 1)) : null;
  return {count, mean: round(mean), median: round(median), stdev: stdev === null ? null : round(stdev)};
}

// --- Performance analysis: model version x state x horizon --------------------------------------------

export type OutcomeCoverage = {pending: number; observed: number; unavailable: number; missed: number};
export type PerformanceBucket = {
  modelVersion: string;
  state: string;
  horizon: string;
  coverage: OutcomeCoverage;
  returnsPct: Distribution;
  positiveShare: number | null;
};

const HORIZON_ORDER = HORIZONS.map(horizon => horizon.id as string);
const byBucketOrder = (a: PerformanceBucket, b: PerformanceBucket) =>
  a.modelVersion.localeCompare(b.modelVersion) || a.state.localeCompare(b.state) || HORIZON_ORDER.indexOf(a.horizon) - HORIZON_ORDER.indexOf(b.horizon);

// Every stored outcome, grouped by model version x signal state x horizon, whatever the outcome status.
// Coverage counts every status so a bucket dominated by pending/unavailable/missed outcomes is visible as
// such, never collapsed into (or silently excluded from) the denominator of the observed-returns stats.
export function performanceReport(signals: StoredSignalRow[], outcomes: StoredOutcomeRow[]): PerformanceBucket[] {
  const byId = new Map(signals.map(signal => [signal.id, signal]));
  type Accumulator = {modelVersion: string; state: string; horizon: string; coverage: OutcomeCoverage; returns: number[]; positive: number};
  const buckets = new Map<string, Accumulator>();
  for (const outcome of outcomes) {
    const signal = byId.get(outcome.signalId);
    if (!signal) continue; // An outcome for a signal not in this read (e.g. a corrupt row skipped upstream).
    const key = `${signal.modelVersion} ${signal.state} ${outcome.horizon}`;
    const bucket = buckets.get(key) ?? {modelVersion: signal.modelVersion, state: signal.state, horizon: outcome.horizon, coverage: {pending: 0, observed: 0, unavailable: 0, missed: 0}, returns: [], positive: 0};
    if (outcome.status === 'pending' || outcome.status === 'observed' || outcome.status === 'unavailable' || outcome.status === 'missed') bucket.coverage[outcome.status]++;
    if (outcome.status === 'observed' && outcome.price !== null && signal.detectedPrice > 0) {
      const returnPct = (outcome.price / signal.detectedPrice - 1) * 100;
      bucket.returns.push(returnPct);
      if (outcome.price > signal.detectedPrice) bucket.positive++;
    }
    buckets.set(key, bucket);
  }
  return [...buckets.values()].map(bucket => ({
    modelVersion: bucket.modelVersion,
    state: bucket.state,
    horizon: bucket.horizon,
    coverage: bucket.coverage,
    returnsPct: distribution(bucket.returns),
    positiveShare: bucket.returns.length ? Number((bucket.positive / bucket.returns.length).toFixed(4)) : null,
  })).sort(byBucketOrder);
}

// --- Calibration: threshold sweep with a time-ordered split --------------------------------------------

// Candidate score thresholds to report against. Fixed, never fit or searched for against stored outcomes
// - a sweep is a descriptive re-slicing of history, not an optimization of lib/goldmine/score.ts's actual
// OPPORTUNITY_MIN_SCORE (60), which this module never reads or changes.
export const CALIBRATION_THRESHOLDS = [40, 50, 60, 70, 80, 90];
// Below this many signals in the evaluation half, a threshold's outcome distribution is reported for
// visibility only; no performance conclusion should be drawn from it.
export const MIN_EVALUATION_SIGNALS = 20;
// Below this many *observed* returns in a given threshold/horizon cell, that cell (and, if true of every
// cell, the whole result) is descriptive only. Reaching MIN_EVALUATION_SIGNALS evaluation-half signals is
// necessary but never sufficient by itself: those signals can still have mostly pending, unavailable or
// missed outcomes, which is little realized evidence regardless of how many signals were detected.
export const MIN_OBSERVED_RETURN_SAMPLES = 20;

// Whether the stored assessment would have been an opportunity at a given score threshold, holding every
// other stored gate/blocker fixed. Only the score_below_threshold blocker is threshold-dependent; every
// other blocker (state not actionable, incomplete risk inputs, unverified contract safety) and every hard
// gate (state REJECTED) are read from the assessment exactly as scoreCandidate already decided them, never
// recomputed - this sweep only asks "what if OPPORTUNITY_MIN_SCORE had been X", nothing else.
export function wouldBeOpportunityAt(assessment: Assessment, threshold: number): boolean {
  if (assessment.state === 'REJECTED') return false;
  const otherBlockers = assessment.blockers.filter(blocker => blocker.id !== 'score_below_threshold');
  return otherBlockers.length === 0 && assessment.score >= threshold;
}

// For a given threshold and horizon: every eligible (evaluation-half, would-be-opportunity-at-threshold)
// signal's outcome status for that horizon, counted explicitly and separately - never collapsed into, or
// silently dropped from, the observed-returns sample. `eligibleWithOutcome` is kept as the observed-return
// sample count (the field earlier versions of this report used); `coverage`/`coverageRatio` make the full
// breakdown (including pending/unavailable/missed) and its completeness explicit.
//
// Cell evidence status - explicit per cell, never implied by a sibling cell or by the evaluation-half size:
//   'not_evaluable' - zero eligible signals for this threshold/horizon at all; there is nothing to report.
//   'insufficient'  - at least one eligible signal, but fewer than MIN_OBSERVED_RETURN_SAMPLES *usable*
//                      observed returns (returns.length - the values distribution() was actually computed
//                      from, not coverage.observed, which counts every outcome row stamped 'observed' even
//                      one whose price/detectedPrice could not produce a finite return).
//   'sufficient'    - at least MIN_OBSERVED_RETURN_SAMPLES usable observed returns.
// A populated 15m cell must never lend credibility to a weak or not-evaluable 1h/6h/24h cell, or to a
// different threshold row - each cell's status is computed only from its own returns.
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
  // Kept for readability alongside cellStatus: true exactly when cellStatus === 'sufficient'. Derived from
  // returnsPct.count (the usable observed-return sample actually used by the distribution), not
  // coverage.observed.
  sufficientEvidence: boolean;
};
export type CalibrationRow = {threshold: number; eligibleCount: number; byHorizon: CalibrationHorizonRow[]};
export type CalibrationResult = {
  // The single model version this calibration was computed over. Signals from any other stored
  // model_version are never mixed into these rows - see calibrationSweep's isolation comment below.
  modelVersion: string;
  // Signals recorded under a model_version other than `modelVersion`, present in the input but excluded
  // from every row below (they are never rescored or reinterpreted under the current thresholds).
  excludedOtherVersionSignals: number;
  cutoffAt: number;
  referenceCount: number;
  evaluationCount: number;
  // Exact reconciliation over every reported cell (thresholds.length * HORIZONS.length): each cell is
  // counted in exactly one of these three, so sufficientCellCount + insufficientCellCount +
  // notEvaluableCellCount === totalCellCount always.
  sufficientCellCount: number;
  insufficientCellCount: number;
  notEvaluableCellCount: number;
  totalCellCount: number;
  // True whenever the report should not be read as a performance conclusion. False only when there is at
  // least one evaluable cell (eligible > 0) AND every evaluable cell individually reached
  // MIN_OBSERVED_RETURN_SAMPLES (insufficientCellCount === 0) AND the evaluation half itself has at least
  // MIN_EVALUATION_SIGNALS signals. A single sufficient cell can never flip this to false while any other
  // evaluable cell remains insufficient - sufficiency is judged per cell, never inferred from a sibling
  // cell or from evaluation-half signal count alone.
  descriptiveOnly: boolean;
  rows: CalibrationRow[];
};

// The midpoint of stored detection times: signals at or after it are the "evaluation" half, reported
// below; signals strictly before it are the "reference" half, used only to place the cutoff
// chronologically and never scored here. Returns null when there is nothing to split (no signals).
export function defaultCutoff(signals: StoredSignalRow[]): number | null {
  if (!signals.length) return null;
  const sorted = [...signals].map(signal => signal.detectedAt).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// Reports, for each candidate threshold, what the opportunity set and its realized outcome distribution
// would have looked like - using only signals detected at or after `cutoffAt`. This is a time-ordered,
// out-of-sample report: no threshold is chosen or tuned based on the evaluation half's own outcomes, and
// the earlier ("reference") half never contributes to the numbers below.
//
// Model-version isolation: this sweep is restricted to signals stored under `options.modelVersion`
// (defaults to the current MODEL_VERSION). A signal recorded under any other model_version is never
// included here - its score, state and blockers were produced by a different (and, for any version other
// than the current one, unimplemented-here) scoring logic, so applying `wouldBeOpportunityAt`'s current
// threshold/blocker rules to it would silently reinterpret another model's output as this one's. Those
// signals remain visible elsewhere (replayAll's unsupportedModelVersions, performanceReport's per-version
// buckets) - `excludedOtherVersionSignals` reports how many were excluded from this calibration, so the
// exclusion is transparent rather than silent.
//
// `descriptiveOnly` is true whenever there is not enough *realized* evidence to draw a conclusion from -
// see the field's comment on CalibrationResult for the exact per-cell rule. A large evaluation half whose
// outcomes are still pending/unavailable/missed must not read as sufficient evidence merely because it
// contains many signals; `rows` are still returned in full for visibility even when descriptiveOnly is
// true, never withheld.
export function calibrationSweep(signals: StoredSignalRow[], outcomes: StoredOutcomeRow[], options: {cutoffAt: number; thresholds?: number[]; modelVersion?: string}): CalibrationResult {
  const {cutoffAt, thresholds = CALIBRATION_THRESHOLDS, modelVersion = MODEL_VERSION} = options;
  const inScope = signals.filter(signal => signal.modelVersion === modelVersion);
  const excludedOtherVersionSignals = signals.length - inScope.length;
  const reference = inScope.filter(signal => signal.detectedAt < cutoffAt);
  const evaluation = inScope.filter(signal => signal.detectedAt >= cutoffAt);
  const outcomesBySignal = new Map<string, StoredOutcomeRow[]>();
  for (const outcome of outcomes) {
    const list = outcomesBySignal.get(outcome.signalId) ?? [];
    list.push(outcome);
    outcomesBySignal.set(outcome.signalId, list);
  }
  let sufficientCellCount = 0, insufficientCellCount = 0, notEvaluableCellCount = 0;
  const rows = thresholds.map(threshold => {
    const eligible = evaluation.filter(signal => wouldBeOpportunityAt(signal.assessment, threshold));
    const byHorizon = HORIZONS.map(({id}) => {
      const coverage: OutcomeCoverage = {pending: 0, observed: 0, unavailable: 0, missed: 0};
      const returns: number[] = [];
      let positive = 0;
      for (const signal of eligible) {
        const outcome = (outcomesBySignal.get(signal.id) ?? []).find(candidate => candidate.horizon === id);
        if (!outcome) continue; // No stored outcome row for this signal/horizon at all - never guessed at.
        if (outcome.status === 'pending' || outcome.status === 'observed' || outcome.status === 'unavailable' || outcome.status === 'missed') coverage[outcome.status]++;
        if (outcome.status === 'observed' && outcome.price !== null && signal.detectedPrice > 0) {
          const returnPct = (outcome.price / signal.detectedPrice - 1) * 100;
          if (Number.isFinite(returnPct)) {
            returns.push(returnPct);
            if (outcome.price > signal.detectedPrice) positive++;
          }
        }
      }
      // Evidence sufficiency is judged from returns.length - the sample distribution() actually computed
      // over - never from coverage.observed, which can exceed returns.length whenever an 'observed' row's
      // price/detectedPrice could not produce a finite, usable return.
      const cellStatus: CellEvidenceStatus = eligible.length === 0 ? 'not_evaluable'
        : returns.length >= MIN_OBSERVED_RETURN_SAMPLES ? 'sufficient' : 'insufficient';
      if (cellStatus === 'sufficient') sufficientCellCount++;
      else if (cellStatus === 'insufficient') insufficientCellCount++;
      else notEvaluableCellCount++;
      return {
        horizon: id as string,
        eligible: eligible.length,
        coverage,
        coverageRatio: eligible.length ? Number((coverage.observed / eligible.length).toFixed(4)) : null,
        eligibleWithOutcome: returns.length,
        returnsPct: distribution(returns),
        positiveShare: returns.length ? Number((positive / returns.length).toFixed(4)) : null,
        cellStatus,
        sufficientEvidence: cellStatus === 'sufficient',
      };
    });
    return {threshold, eligibleCount: eligible.length, byHorizon};
  });
  const totalCellCount = sufficientCellCount + insufficientCellCount + notEvaluableCellCount;
  return {
    modelVersion,
    sufficientCellCount,
    insufficientCellCount,
    notEvaluableCellCount,
    totalCellCount,
    excludedOtherVersionSignals,
    cutoffAt,
    referenceCount: reference.length,
    evaluationCount: evaluation.length,
    // False only when there is at least one evaluable (eligible > 0) cell, none of those evaluable cells is
    // insufficient, and the evaluation half itself reached MIN_EVALUATION_SIGNALS. A single sufficient cell
    // can never outweigh a remaining insufficient one (insufficientCellCount > 0 keeps this true).
    descriptiveOnly: evaluation.length < MIN_EVALUATION_SIGNALS || insufficientCellCount > 0 || sufficientCellCount === 0,
    rows,
  };
}
