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
