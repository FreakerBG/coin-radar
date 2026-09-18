// Goldmine Intelligence (Stage 03A). POST scans: settles due signal outcomes, then discovers, scores
// (lib/goldmine/score.ts) and records candidates. GET reads tracked signals and their outcomes. Both are
// signed-in only; POST is same-origin and runs under one shared lock. Nothing here trades, sizes a
// position or requests X; scores come only from the provider data in the stored snapshot.
import {getChatGPTUser} from '@/app/chatgpt-auth';
import {reportFailure} from '@/lib/diagnostics';
import {discoverSolanaPairs} from '@/lib/market';
import {acquireLock, db, releaseLock, sameOrigin} from '@/lib/research-db';
import {DISCLAIMER, MODEL_VERSION, scoreCandidate, type Assessment} from '@/lib/goldmine/score';
import {attachSocialEvidence, evaluateOutcomes, readTracking, recordSignals} from '@/lib/goldmine/signals';
import {bestPoolSnapshots} from '@/lib/goldmine/snapshot';
import {withContractSafety} from '@/lib/goldmine/contract-safety';

const noStore = {'Cache-Control': 'no-store'};
const LOCK_ID = 'goldmine:scan';
const COVERAGE = 'Latest DEX Screener profiles and promoted tokens; up to 30 Solana tokens, highest-liquidity pool per token. Not a whole-market scan.';

// Opportunities first, rejected last, then by score; the address breaks ties so the order is deterministic.
const rank = (a: Assessment) => a.opportunity ? 0 : a.state === 'REJECTED' ? 2 : 1;
const byRank = (a: Assessment, b: Assessment) => rank(a) - rank(b) || b.score - a.score || a.address.localeCompare(b.address);

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return Response.json({error: 'Sign in required.'}, {status: 401, headers: noStore});
  try {
    const tracking = await readTracking(db());
    return Response.json({modelVersion: MODEL_VERSION, ...tracking, disclaimer: DISCLAIMER}, {headers: noStore});
  } catch (error) {
    reportFailure('goldmine', 'load', error);
    return Response.json({error: 'Signal storage unavailable.'}, {status: 503, headers: noStore});
  }
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({error: 'Sign in required.'}, {status: 401, headers: noStore});
  if (!sameOrigin(request)) return Response.json({error: 'Same-origin request required.'}, {status: 403, headers: noStore});
  let lock: string | null = null;
  try {
    const database = db();
    lock = await acquireLock(LOCK_ID);
    if (!lock) return Response.json({status: 'busy', candidates: []}, {headers: noStore});
    const now = Date.now();
    const outcomes = await evaluateOutcomes(database, now);

    let discovered;
    try {
      discovered = await discoverSolanaPairs();
    } catch (error) {
      reportFailure('goldmine', 'provider', error, 'warn');
      return Response.json({
        status: 'provider_unavailable', modelVersion: MODEL_VERSION, asOf: new Date(now).toISOString(), candidates: [],
        tracking: {newSignals: 0, outcomes}, message: 'Market provider unavailable. No candidates were scored or recorded.', disclaimer: DISCLAIMER,
      }, {headers: noStore});
    }

    const snapshots = await attachSocialEvidence(database, bestPoolSnapshots(discovered.pairs, now, discovered.boosted));
    const prescored = snapshots.map(snapshot => ({snapshot, assessment: scoreCandidate(snapshot)}));
    const scored = await withContractSafety(prescored, now);
    const newSignals = await recordSignals(database, scored, now);
    const candidates = scored.sort((a, b) => byRank(a.assessment, b.assessment)).map(({snapshot, assessment}) => ({...assessment, snapshot}));
    return Response.json({
      status: 'checked', modelVersion: MODEL_VERSION, asOf: new Date(now).toISOString(), candidates,
      opportunities: candidates.filter(candidate => candidate.opportunity).length,
      tracking: {newSignals, outcomes}, warnings: discovered.warnings, coverage: COVERAGE, disclaimer: DISCLAIMER,
    }, {headers: noStore});
  } catch (error) {
    reportFailure('goldmine', 'scan', error);
    return Response.json({error: 'Goldmine scan failed.'}, {status: 503, headers: noStore});
  } finally {
    if (lock) await releaseLock(LOCK_ID, lock).catch(error => reportFailure('goldmine', 'release-lock', error));
  }
}
