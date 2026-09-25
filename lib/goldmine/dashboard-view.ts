// Pure view logic for the Goldmine dashboard panel (app/goldmine-panel.tsx), kept separate from JSX so
// it is directly testable with node:test, the same way lib/goldmine/score.ts is. Nothing here calls a
// provider or recomputes a safety decision: it only classifies data the API already returned.
import type {Assessment} from './score';
import type {CandidateSnapshot} from './snapshot';

export type PostedCandidate = Assessment & {snapshot: CandidateSnapshot};
export type ScanStatus = 'idle' | 'loading' | 'opportunities' | 'empty' | 'busy' | 'unavailable' | 'error';

// How long a scan result is shown as current before the panel calls it stale and asks for a fresh scan.
export const STALE_AFTER_MS = 5 * 60000;

// A missing `asOf` means no scan has run yet this session (the 'idle' state, not staleness). An `asOf`
// that cannot be parsed is treated as stale rather than fresh: we cannot confirm the data is current, and
// the cost of an unnecessary "refresh" hint is far lower than the cost of showing old data as current.
export function isStale(asOf: string | null, now: number): boolean {
  if (!asOf) return false;
  const observedAt = Date.parse(asOf);
  return !Number.isFinite(observedAt) || now - observedAt > STALE_AFTER_MS;
}

// Only a candidate the backend itself marked `opportunity: true` is ever shown as one. This never
// re-derives that decision from `snapshot.contractSafety` or any other field: by construction (the
// opportunity gate in lib/goldmine/score.ts), every opportunity already has contractSafety.status ===
// 'verified', so the frontend only needs to trust the flag, never recompute or override it.
export function opportunitiesOf(candidates: PostedCandidate[]): PostedCandidate[] {
  return candidates.filter(candidate => candidate.opportunity === true);
}

// One classification for the whole scan result, checked in this order, so the panel never has to
// reconstruct "what state is this" from several booleans whose interaction could itself misrepresent a
// state (for example, showing stale opportunities as if they were a fresh empty result).
export function scanState(input: {
  loading: boolean;
  error: string | null;
  status: 'checked' | 'busy' | 'provider_unavailable' | null;
  opportunityCount: number;
}): ScanStatus {
  if (input.loading) return 'loading';
  if (input.error) return 'error';
  if (input.status === null) return 'idle';
  if (input.status === 'busy') return 'busy';
  if (input.status === 'provider_unavailable') return 'unavailable';
  return input.opportunityCount > 0 ? 'opportunities' : 'empty';
}

// The most recent recorded batch of signals, as GET /api/goldmine returns it (lib/goldmine/signals.ts
// readLatestBatch). Null when nothing has ever been recorded on this deployment.
export type LatestBatch = {detectedAt: string; signalCount: number; opportunityCount: number; byState: {state: string; count: number}[]};

// How long the panel waits before pointing out that nothing new has been recorded. The Vercel+Turso
// deployment scans once a day (`0 0 * * *` in vercel.json; the Hobby plan allows nothing more frequent,
// docs/deployment-runbook.md 10.5) and Hobby cron timing drifts up to 59 minutes, so a scheduler
// working exactly as configured can legitimately leave a gap a little over 24 hours. 26 hours clears
// that drift with room to spare, so this never cries wolf on a healthy deployment - and a gap past it
// is worth the owner's attention rather than noise.
export const BATCH_OVERDUE_AFTER_MS = 26 * 60 * 60 * 1000;

// Null for "no batch" and for an unparseable timestamp: age is unknown in both cases, and guessing one
// would be worse than saying nothing, since every caller below already handles null explicitly.
export function latestBatchAgeMs(latest: LatestBatch | null, now: number): number | null {
  if (!latest) return null;
  const detectedAt = Date.parse(latest.detectedAt);
  return Number.isFinite(detectedAt) ? now - detectedAt : null;
}

// Deliberately false when the age is unknown: an unreadable timestamp is a data problem, not evidence
// that scanning stopped, and claiming "overdue" from it would be an unfounded alarm about the
// scheduler. The unknown case is surfaced by latestBatchCountsLabel instead.
export function isLatestBatchOverdue(latest: LatestBatch | null, now: number): boolean {
  const age = latestBatchAgeMs(latest, now);
  return age !== null && age > BATCH_OVERDUE_AFTER_MS;
}

// What the last recorded batch contained. Says "recorded", never "scanned": a scan that records nothing
// - because every candidate is already recorded in the same state and six-hour bucket, or because
// discovery failed - still ran, and this line must not be read as its absence.
export function latestBatchCountsLabel(latest: LatestBatch | null): string {
  if (!latest) return 'No signals have been recorded yet on this deployment.';
  const signals = `${latest.signalCount} signal${latest.signalCount === 1 ? '' : 's'} recorded`;
  const opportunities = latest.opportunityCount === 0
    ? 'none met every safety and momentum gate'
    : `${latest.opportunityCount} met every safety and momentum gate`;
  return `${signals}, ${opportunities}.`;
}

// The batch broken down by state, so "28 recorded, 0 opportunities" is legible as a result rather than
// as a silence. Empty string when there is nothing to break down, so the caller can omit the element
// entirely instead of rendering a stray separator.
export function latestBatchStatesLabel(latest: LatestBatch | null): string {
  if (!latest || !latest.byState.length) return '';
  return latest.byState.map(entry => `${entry.count} ${entry.state}`).join(' · ');
}

// '' unless the gap is genuinely longer than the configured scan interval allows for. Names the
// threshold rather than asserting a cause: nothing here can tell a stopped scheduler apart from a
// scheduler whose scans all found nothing new to record.
export function latestBatchStalenessNote(latest: LatestBatch | null, now: number): string {
  if (!isLatestBatchOverdue(latest, now)) return '';
  return 'Nothing new recorded in over 26 hours, which is longer than this deployment’s daily scan interval. A scan that finds nothing new to record also leaves this unchanged.';
}
