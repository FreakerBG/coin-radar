// Read-only diagnosis of why the current model's stored signals did or did not become opportunities.
// Counts come from the bounded, validated backtest read, not all history. A signal may have multiple
// blockers or rejections, so reason counts are deliberately not a partition of the sample.
import type {StoredSignalRow} from './signals';
import {MODEL_VERSION} from './score';

export function filterFunnel(signals: StoredSignalRow[]) {
  const current = signals.filter(signal => signal.modelVersion === MODEL_VERSION);
  const rejectionCounts: Record<string, number> = {};
  const blockerCounts: Record<string, number> = {};
  const safety = {verified: 0, unsafe: 0, unavailable: 0};
  let rejected = 0, actionable = 0, opportunities = 0, safetyOnlyNearMisses = 0;
  for (const signal of current) {
    const {assessment, snapshot} = signal;
    safety[snapshot.contractSafety.status]++;
    if (assessment.state === 'REJECTED') rejected++;
    else if (assessment.state === 'EARLY' || assessment.state === 'BUILDING' || assessment.state === 'BREAKOUT') actionable++;
    if (assessment.opportunity) opportunities++;
    for (const gate of assessment.rejections) rejectionCounts[gate.id] = (rejectionCounts[gate.id] ?? 0) + 1;
    for (const gate of assessment.blockers) blockerCounts[gate.id] = (blockerCounts[gate.id] ?? 0) + 1;
    if (!assessment.opportunity && assessment.blockers.length > 0 &&
        assessment.blockers.every(gate => gate.id === 'contract_safety_unverified')) safetyOnlyNearMisses++;
  }
  return {
    modelVersion: MODEL_VERSION,
    sampledSignals: current.length,
    excludedOtherVersions: signals.length - current.length,
    rejected, actionable, opportunities, safetyOnlyNearMisses,
    safety, rejectionCounts, blockerCounts,
    note: 'Bounded recent sample. Reason counts overlap; safety-only near misses are not verified opportunities or trade recommendations.',
  };
}
