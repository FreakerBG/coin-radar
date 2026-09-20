// The Goldmine scan pipeline (Stage 03A-03D), extracted from app/api/goldmine/route.ts so a
// scheduled entry point (app/api/goldmine/scheduled/route.ts) can run exactly the same pipeline.
// Pure with respect to auth and locking: the caller is responsible for sign-in/CSRF checks (the
// interactive route) or scheduler authorization (lib/goldmine/scheduled-auth.ts), and for acquiring
// and releasing the shared `goldmine:scan` lock (lib/research-db.ts) around this call. This module
// never changes: settle due outcomes, discover, score, attach contract safety, re-score, record.
import {reportFailure} from '@/lib/diagnostics';
import {discoverSolanaPairs} from '@/lib/market';
import {DISCLAIMER, MODEL_VERSION, scoreCandidate, type Assessment} from './score';
import {attachSocialEvidence, evaluateOutcomes, recordSignals} from './signals';
import {bestPoolSnapshots, contractSafetySummary} from './snapshot';
import {withContractSafety} from './contract-safety';

const COVERAGE = 'Latest DEX Screener profiles and promoted tokens; up to 30 Solana tokens, highest-liquidity pool per token. Not a whole-market scan.';

// Opportunities first, rejected last, then by score; the address breaks ties so the order is deterministic.
const rank = (a: Assessment) => a.opportunity ? 0 : a.state === 'REJECTED' ? 2 : 1;
const byRank = (a: Assessment, b: Assessment) => rank(a) - rank(b) || b.score - a.score || a.address.localeCompare(b.address);

export type GoldmineScanResult = {
  status: 'checked' | 'provider_unavailable';
  modelVersion: string;
  asOf: string;
  candidates: unknown[];
  opportunities?: number;
  tracking: {newSignals: number; outcomes: Awaited<ReturnType<typeof evaluateOutcomes>>};
  warnings?: string[];
  coverage?: string;
  message?: string;
  disclaimer: string;
};

// Settles due signal outcomes, then discovers, scores (lib/goldmine/score.ts), attaches contract
// safety (lib/goldmine/contract-safety.ts) for actionable candidates, re-scores and records. Nothing
// here trades, sizes a position or requests X; scores come only from the provider data in the stored
// snapshot. The caller already holds the `goldmine:scan` lock and is signed in/authorized.
export async function runGoldmineScan(database: D1Database, now: number): Promise<GoldmineScanResult> {
  const outcomes = await evaluateOutcomes(database, now);

  let discovered;
  try {
    discovered = await discoverSolanaPairs();
  } catch (error) {
    reportFailure('goldmine', 'provider', error, 'warn');
    return {
      status: 'provider_unavailable', modelVersion: MODEL_VERSION, asOf: new Date(now).toISOString(), candidates: [],
      tracking: {newSignals: 0, outcomes}, message: 'Market provider unavailable. No candidates were scored or recorded.', disclaimer: DISCLAIMER,
    };
  }

  const snapshots = await attachSocialEvidence(database, bestPoolSnapshots(discovered.pairs, now, discovered.boosted));
  const prescored = snapshots.map(snapshot => ({snapshot, assessment: scoreCandidate(snapshot)}));
  const scored = await withContractSafety(prescored, now);
  const newSignals = await recordSignals(database, scored, now);
  // Response-shaping only: storage above (recordSignals) still gets the full scored snapshot, including
  // the raw contractSafety facts. Here, for the client, contractSafety is reduced to the same minimal
  // shape GET already returns (lib/goldmine/snapshot.ts contractSafetySummary), so this response never
  // leaks provider facts/scores/risk text that GET withholds. Defensive against malformed/legacy values.
  const candidates = scored.sort((a, b) => byRank(a.assessment, b.assessment)).map(({snapshot, assessment}) => ({
    ...assessment,
    snapshot: {...snapshot, contractSafety: contractSafetySummary(snapshot.contractSafety)},
  }));
  return {
    status: 'checked', modelVersion: MODEL_VERSION, asOf: new Date(now).toISOString(), candidates,
    opportunities: candidates.filter(candidate => candidate.opportunity).length,
    tracking: {newSignals, outcomes}, warnings: discovered.warnings, coverage: COVERAGE, disclaimer: DISCLAIMER,
  };
}
