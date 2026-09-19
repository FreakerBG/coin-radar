// The Goldmine scan pipeline, shared by every entry point that may run it (the signed-in POST route
// and the fail-closed, secret-protected scheduled route). Settles due outcomes, then discovers, scores,
// verifies contract safety and records candidates. Callers are responsible for authorization and for
// holding the shared `goldmine:scan` lock before calling this; it does neither itself.
import {reportFailure} from '../diagnostics';
import {discoverSolanaPairs} from '../market';
import {scoreCandidate, type Assessment} from './score';
import {attachSocialEvidence, evaluateOutcomes, recordSignals, type OutcomeRun} from './signals';
import {bestPoolSnapshots, contractSafetySummary, type CandidateSnapshot, type ContractSafetySummary} from './snapshot';
import {withContractSafety} from './contract-safety';

export const COVERAGE = 'Latest DEX Screener profiles and promoted tokens; up to 30 Solana tokens, highest-liquidity pool per token. Not a whole-market scan.';

// Opportunities first, rejected last, then by score; the address breaks ties so the order is deterministic.
const rank = (a: Assessment) => a.opportunity ? 0 : a.state === 'REJECTED' ? 2 : 1;
const byRank = (a: Assessment, b: Assessment) => rank(a) - rank(b) || b.score - a.score || a.address.localeCompare(b.address);

// Same reduction the POST route has always served: contractSafety narrowed from the stored ContractSafety
// (facts, provenance) to the client-facing ContractSafetySummary (lib/goldmine/snapshot.ts).
export type ScannedCandidate = Assessment & {snapshot: Omit<CandidateSnapshot, 'contractSafety'> & {contractSafety: ContractSafetySummary}};
export type ScanResult =
  | {status: 'provider_unavailable'; asOf: string; candidates: []; tracking: {newSignals: 0; outcomes: OutcomeRun}; message: string}
  | {status: 'checked'; asOf: string; candidates: ScannedCandidate[]; opportunities: number; tracking: {newSignals: number; outcomes: OutcomeRun}; warnings: string[]; coverage: string};

// Runs one scan: settle due outcomes, then discover, score, verify contract safety and record. The
// caller already holds the scan lock and has authorized the request; this never checks either.
export async function runGoldmineScan(database: D1Database, now: number): Promise<ScanResult> {
  const outcomes = await evaluateOutcomes(database, now);

  let discovered;
  try {
    discovered = await discoverSolanaPairs();
  } catch (error) {
    reportFailure('goldmine', 'provider', error, 'warn');
    return {
      status: 'provider_unavailable', asOf: new Date(now).toISOString(), candidates: [],
      tracking: {newSignals: 0, outcomes}, message: 'Market provider unavailable. No candidates were scored or recorded.',
    };
  }

  const snapshots = await attachSocialEvidence(database, bestPoolSnapshots(discovered.pairs, now, discovered.boosted));
  const prescored = snapshots.map(snapshot => ({snapshot, assessment: scoreCandidate(snapshot)}));
  const scored = await withContractSafety(prescored, now);
  const newSignals = await recordSignals(database, scored, now);
  // Response-shaping only: storage above (recordSignals) still gets the full scored snapshot, including
  // the raw contractSafety facts. Here, for the client, contractSafety is reduced to the same minimal
  // shape GET already returns (lib/goldmine/snapshot.ts contractSafetySummary), so a caller never leaks
  // provider facts/scores/risk text that GET withholds. Defensive against malformed/legacy values.
  const candidates = scored.sort((a, b) => byRank(a.assessment, b.assessment)).map(({snapshot, assessment}) => ({
    ...assessment,
    snapshot: {...snapshot, contractSafety: contractSafetySummary(snapshot.contractSafety)},
  }));
  return {
    status: 'checked', asOf: new Date(now).toISOString(), candidates,
    opportunities: candidates.filter(candidate => candidate.opportunity).length,
    tracking: {newSignals, outcomes}, warnings: discovered.warnings, coverage: COVERAGE,
  };
}
