// Goldmine backtesting & calibration (Stage 03D). GET only, signed-in, read-only: it recomputes and
// aggregates already-stored goldmine_signals/goldmine_outcomes rows (lib/goldmine/backtest.ts). It makes
// no provider request, changes no live scoring behavior and never writes to storage.
import {getChatGPTUser} from '@/app/chatgpt-auth';
import {reportFailure} from '@/lib/diagnostics';
import {db} from '@/lib/research-db';
import {DISCLAIMER, MODEL_VERSION} from '@/lib/goldmine/score';
import {cadenceReport, EVALUATION_SCHEDULE_VERSION} from '@/lib/goldmine/cadence';
import {readAllSignalsWithOutcomes, readSignalTotals} from '@/lib/goldmine/signals';
import {BACKTEST_LIMITATIONS, calibrationSweep, defaultCutoff, denominatorSplit, performanceReport, replayAll, reportCoverage} from '@/lib/goldmine/backtest';
import {filterFunnel} from '@/lib/goldmine/filter-funnel';

const noStore = {'Cache-Control': 'no-store'};

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return Response.json({error: 'Sign in required.'}, {status: 401, headers: noStore});
  try {
    const database = db();
    // One read timestamp for the whole report, so every derived expired-unswept count, elapsed duration and
    // coverage total in the response describes the same instant. Taken once and only read.
    const now = Date.now();
    const {signals, outcomes, skippedMalformedSignals, skippedMalformedOutcomes, truncated} = await readAllSignalsWithOutcomes(database);
    // All-history counts, deliberately from their own COUNT query rather than from `signals` above: that
    // read is bounded and can report `truncated`, so it cannot answer "how many opportunities have ever
    // been recorded". One extra read-only query.
    const totals = await readSignalTotals(database);
    const replay = replayAll(signals);
    const performance = performanceReport(signals, outcomes, now);
    const denominators = denominatorSplit(signals, outcomes, now);
    // The calibration cutoff is computed from the current model version's signals only, so the
    // chronological split is not skewed by detection timestamps from other, unrelated model versions.
    // calibrationSweep itself independently restricts (and reports) that same isolation - see its comment.
    const currentVersionSignals = signals.filter(signal => signal.modelVersion === MODEL_VERSION);
    const cutoffAt = defaultCutoff(currentVersionSignals);
    const calibration = cutoffAt === null ? null : calibrationSweep(signals, outcomes, {cutoffAt, now});
    return Response.json({
      modelVersion: MODEL_VERSION,
      // Separate from modelVersion on purpose: this versions *when* outcomes are observed, not how a
      // candidate is scored. Stage 06 changed the former and deliberately left the latter alone.
      evaluationScheduleVersion: EVALUATION_SCHEDULE_VERSION,
      // The cadence this report was computed under, plus every known horizon's target, grace window and
      // whether that cadence can observe it at all (lib/goldmine/cadence.ts).
      cadence: cadenceReport(),
      generatedAt: now,
      totalSignals: signals.length,
      // All of stored history, independent of this request's read bound. `totals.opportunities === 0` is a
      // result the dashboard states plainly, not an absence of data.
      totals,
      // Control (REJECTED) versus strategy (actionable) versus opportunity counts, kept apart so a control
      // observation is never read as evidence about the strategy.
      denominators,
      filterFunnel: filterFunnel(signals),
      skippedMalformedRows: skippedMalformedSignals,
      skippedMalformedOutcomes,
      truncated,
      // The detection-time window this report actually covers, and whether it reaches the 30-day research
      // target. A bounded read is never described as 30 days or as all history.
      coverage: reportCoverage(signals, totals.signals, truncated, now),
      replay: {
        currentVersionSignals: replay.currentVersionSignals,
        matched: replay.matched,
        mismatchedCount: replay.mismatchedCount,
        mismatchedSample: replay.mismatchedSample,
        mismatchedSampleTruncated: replay.mismatchedSampleTruncated,
        unsupportedCount: replay.unsupportedCount,
        unsupportedModelVersions: replay.unsupportedModelVersions,
        invalidCount: replay.invalidCount,
      },
      performance,
      calibration,
      limitations: BACKTEST_LIMITATIONS,
      disclaimer: DISCLAIMER,
    }, {headers: noStore});
  } catch (error) {
    reportFailure('goldmine', 'backtest', error);
    return Response.json({error: 'Backtest storage unavailable.'}, {status: 503, headers: noStore});
  }
}
