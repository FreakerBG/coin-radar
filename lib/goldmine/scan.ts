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

// Lease length for the shared `goldmine:scan` lock (lib/research-db.ts). It must exceed the worst
// case runtime of runGoldmineScan(), because acquireLock() hands out a lease, not a mutex: a scan
// that outlives its lease has it expire underneath it, and a second scan then legitimately acquires
// and runs concurrently. Two concurrent scans call Date.now() at different instants, so the signal
// ids they derive differ, the INSERT OR IGNORE in recordSignals() does not collapse them, and the
// same token is recorded twice for one window - which then skews every outcome and backtest
// statistic computed over those rows.
//
// The previous 60s default was already below the pipeline’s own provider budgets, which alone come
// to roughly: 10s settling outcomes (5 parallel batches, lib/goldmine/signals.ts), up to ~24s
// discovery (lib/market.ts, 12s per request), and up to 28s of contract safety (SCAN_BUDGET_MS plus
// one in-flight 8s request, lib/goldmine/contract-safety.ts) - before a single database round trip,
// which on Turso crosses the network rather than staying in-process as it does on D1.
//
// 300s is the ceiling the platform itself enforces: Vercel terminates a function at its max duration,
// 300s on this account’s plan (Hobby; vercel.com/docs/functions/limitations). A scan cannot still be
// running when this lease expires, because the platform will have killed it first. The cost of the
// longer lease is that a scan killed mid-flight blocks the next one for up to 5 minutes; for a
// once-a-day cron plus occasional manual scans that is the right trade against duplicate signals.
export const SCAN_LOCK_TTL_MS = 300_000;
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
