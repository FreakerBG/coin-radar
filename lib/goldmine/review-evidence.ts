// Public evidence is an explicit allow-list, never a copy of the provider report.
// Display only: this module does not score, verify, fetch, or change opportunity eligibility.
import {at} from './snapshot';

export type ReviewEvidence = {
  market: {source: 'dexscreener' | null; checkedAt: number | null; liquidityUsd: number | null; marketCapUsd: number | null; volume1hUsd: number | null; buys1h: number | null; sells1h: number | null; promoted: boolean | null};
  contract: {source: 'rugcheck' | null; checkedAt: number | null; mintAuthorityRenounced: boolean | null; freezeAuthorityRenounced: boolean | null; lpLockedPct: number | null; topHolderPct: number | null; topHoldersPct: number | null; creatorHoldingsPct: number | null; insiderNetworksDetected: number | null; rugged: boolean | null};
};
const amount = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const percentage = (value: unknown) => {const n = amount(value); return n !== null && n <= 100 ? n : null;};
const count = (value: unknown) => {const n = amount(value); return n !== null && Number.isSafeInteger(n) ? n : null;};
const bool = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;
const timestamp = (value: unknown) => {const n = count(value); return n !== null && n > 0 && n <= 8640000000000000 ? n : null;};

export function reviewEvidence(snapshot: unknown, expected?: {address: string; pair: string}): ReviewEvidence {
  if (expected && (at(snapshot, 'address') !== expected.address || at(snapshot, 'pair') !== expected.pair)) snapshot = null;
  const marketKnown = at(snapshot, 'source') === 'dexscreener';
  const safety = at(snapshot, 'contractSafety');
  const contractKnown = at(safety, 'source') === 'rugcheck' && ['verified', 'unsafe'].includes(String(at(safety, 'status')));
  const market = (...path: string[]) => marketKnown ? at(snapshot, ...path) : undefined;
  const fact = (key: string) => contractKnown ? at(safety, 'facts', key) : undefined;
  return {
    market: {source: marketKnown ? 'dexscreener' : null, checkedAt: timestamp(market('observedAt')),
      liquidityUsd: amount(market('liquidityUsd')), marketCapUsd: amount(market('marketCapUsd')), volume1hUsd: amount(market('volumeUsd', 'h1')),
      buys1h: count(market('txns', 'h1', 'buys')), sells1h: count(market('txns', 'h1', 'sells')), promoted: bool(market('promoted'))},
    contract: {source: contractKnown ? 'rugcheck' : null, checkedAt: timestamp(contractKnown ? at(safety, 'checkedAt') : undefined),
      mintAuthorityRenounced: bool(fact('mintAuthorityRenounced')), freezeAuthorityRenounced: bool(fact('freezeAuthorityRenounced')),
      lpLockedPct: percentage(fact('lpLockedPct')), topHolderPct: percentage(fact('topHolderPct')), topHoldersPct: percentage(fact('topHoldersPct')),
      creatorHoldingsPct: percentage(fact('creatorHoldingsPct')), insiderNetworksDetected: count(fact('insiderNetworksDetected')), rugged: bool(fact('rugged'))},
  };
}

// Age describes a stored observation, not how recently this API response was downloaded.
export function evidenceAge(checkedAt: number | null, now: number): string {
  if (checkedAt === null || timestamp(checkedAt) === null || !Number.isFinite(now) || checkedAt > now) return 'Age unknown';
  const minutes = Math.floor((now - checkedAt) / 60000);
  return minutes < 1 ? 'Less than 1 minute old' : minutes < 60 ? `${minutes} minute${minutes === 1 ? '' : 's'} old` : `${Math.floor(minutes / 60)} hour${Math.floor(minutes / 60) === 1 ? '' : 's'} old`;
}

// Near misses remain research-only. Never promote them or recompute the backend's decision.
export function nearMisses<T extends {opportunity: boolean; state: string; score: number}>(signals: T[]): T[] {
  return signals.filter(s => s.opportunity === false && ['EARLY', 'BUILDING', 'BREAKOUT'].includes(s.state) && Number.isFinite(s.score) && s.score >= 60 && s.score <= 100)
    .sort((a, b) => b.score - a.score).slice(0, 10);
}
