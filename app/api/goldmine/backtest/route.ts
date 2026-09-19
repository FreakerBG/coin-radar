// Goldmine backtesting & calibration (Stage 03D). GET only, signed-in, read-only: it recomputes and
// aggregates already-stored goldmine_signals/goldmine_outcomes rows (lib/goldmine/backtest.ts). It makes
// no provider request, changes no live scoring behavior and never writes to storage.
import {getChatGPTUser} from '@/app/chatgpt-auth';
import {reportFailure} from '@/lib/diagnostics';
import {db} from '@/lib/research-db';
import {DISCLAIMER, MODEL_VERSION} from '@/lib/goldmine/score';
import {readAllSignalsWithOutcomes} from '@/lib/goldmine/signals';
import {BACKTEST_LIMITATIONS, calibrationSweep, defaultCutoff, performanceReport, replayAll} from '@/lib/goldmine/backtest';

const noStore = {'Cache-Control': 'no-store'};

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return Response.json({error: 'Sign in required.'}, {status: 401, headers: noStore});
  try {
    const {signals, outcomes, skippedMalformedSignals, skippedMalformedOutcomes, truncated} = await readAllSignalsWithOutcomes(db());
    const replay = replayAll(signals);
    const performance = performanceReport(signals, outcomes);
    // The calibration cutoff is computed from the current model version's signals only, so the
    // chronological split is not skewed by detection timestamps from other, unrelated model versions.
    // calibrationSweep itself independently restricts (and reports) that same isolation - see its comment.
    const currentVersionSignals = signals.filter(signal => signal.modelVersion === MODEL_VERSION);
    const cutoffAt = defaultCutoff(currentVersionSignals);
    const calibration = cutoffAt === null ? null : calibrationSweep(signals, outcomes, {cutoffAt});
    return Response.json({
      modelVersion: MODEL_VERSION,
      totalSignals: signals.length,
      skippedMalformedRows: skippedMalformedSignals,
      skippedMalformedOutcomes,
      truncated,
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
