// Unattended scheduled Goldmine scan: runs the exact same pipeline as POST /api/goldmine
// (lib/goldmine/scan.ts) under the same shared lock (`goldmine:scan`, lib/research-db.ts), so an
// interactive scan and a scheduled one can never duplicate signals or race. There is no signed-in
// user and no browser origin here, so this never uses getChatGPTUser()/sameOrigin(); authorization is
// entirely the shared-secret check in lib/goldmine/scheduled-auth.ts.
//
// Two HTTP methods, same authorization and pipeline, for two different callers:
//   GET   Vercel Cron only ever sends GET requests to a `crons` entry (vercel.json); the platform
//         auto-adds `Authorization: Bearer <CRON_SECRET>` when that project env var is set.
//   POST  Any other scheduler or manual trigger that can set an arbitrary header
//         (`x-goldmine-cron-secret`), including a future Cloudflare Worker cron trigger.
// Both accept either convention (lib/goldmine/scheduled-auth.ts) - a caller is never locked out of a
// method just because it uses the "other" convention.
import { reportFailure } from '@/lib/diagnostics';
import { acquireLock, db, releaseLock } from '@/lib/research-db';
import { runGoldmineScan } from '@/lib/goldmine/scan';
import { isAuthorizedScheduledScan } from '@/lib/goldmine/scheduled-auth';

const noStore = { 'Cache-Control': 'no-store' };
const LOCK_ID = 'goldmine:scan';

async function scan(request: Request): Promise<Response> {
  if (!isAuthorizedScheduledScan(request)) {
    return Response.json({ error: 'Not authorized.' }, { status: 401, headers: noStore });
  }
  let lock: string | null = null;
  try {
    const database = db();
    lock = await acquireLock(LOCK_ID);
    if (!lock) return Response.json({ status: 'busy', candidates: [] }, { headers: noStore });
    const result = await runGoldmineScan(database, Date.now());
    return Response.json(result, { headers: noStore });
  } catch (error) {
    reportFailure('goldmine', 'scheduled-scan', error);
    return Response.json({ error: 'Goldmine scan failed.' }, { status: 503, headers: noStore });
  } finally {
    if (lock) await releaseLock(LOCK_ID, lock).catch(error => reportFailure('goldmine', 'release-lock', error));
  }
}

export async function GET(request: Request) {
  return scan(request);
}

export async function POST(request: Request) {
  return scan(request);
}
