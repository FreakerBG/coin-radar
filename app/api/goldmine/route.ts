// Goldmine Intelligence (Stage 03A). POST scans: settles due signal outcomes, then discovers, scores
// (lib/goldmine/score.ts) and records candidates. GET reads tracked signals and their outcomes. Both are
// signed-in only; POST is same-origin and runs under one shared lock. Nothing here trades, sizes a
// position or requests X; scores come only from the provider data in the stored snapshot.
import {getChatGPTUser} from '@/app/chatgpt-auth';
import {reportFailure} from '@/lib/diagnostics';
import {acquireLock, db, releaseLock, sameOrigin} from '@/lib/research-db';
import {DISCLAIMER, MODEL_VERSION} from '@/lib/goldmine/score';
import {readTracking} from '@/lib/goldmine/signals';
import {runGoldmineScan} from '@/lib/goldmine/scan';

const noStore = {'Cache-Control': 'no-store'};
const LOCK_ID = 'goldmine:scan';

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
    const result = await runGoldmineScan(database, Date.now());
    return Response.json({modelVersion: MODEL_VERSION, ...result, disclaimer: DISCLAIMER}, {headers: noStore});
  } catch (error) {
    reportFailure('goldmine', 'scan', error);
    return Response.json({error: 'Goldmine scan failed.'}, {status: 503, headers: noStore});
  } finally {
    if (lock) await releaseLock(LOCK_ID, lock).catch(error => reportFailure('goldmine', 'release-lock', error));
  }
}
