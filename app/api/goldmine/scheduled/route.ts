// Unattended scheduled Goldmine scan: both methods use the same detection pipeline and shared
// lock (`goldmine:scan`, lib/research-db.ts), so an
// interactive scan and a scheduled one can never duplicate signals or race. There is no signed-in
// user and no browser origin here, so this never uses getChatGPTUser()/sameOrigin(); authorization is
// entirely the shared-secret check in lib/goldmine/scheduled-auth.ts.
//
// Two HTTP methods, same authorization and lock, but intentionally different outcome behavior:
//   GET   Vercel Cron only ever sends GET requests to a `crons` entry (vercel.json); the platform
//         auto-adds `Authorization: Bearer <CRON_SECRET>` when that project env var is set.
//         This remains the daily full scan, including outcome settlement.
//   POST  Any other scheduler or manual trigger that can set an arbitrary header
//         (`x-goldmine-cron-secret`), including a future Cloudflare Worker cron trigger.
//         This detects and records candidates but never settles outcomes.
// Both accept either convention (lib/goldmine/scheduled-auth.ts) - a caller is never locked out of a
// method just because it uses the "other" convention.
import { reportFailure } from '@/lib/diagnostics';
import { acquireLock, db, releaseLock } from '@/lib/research-db';
import { runGoldmineDetection, runGoldmineScan, SCAN_LOCK_TTL_MS } from '@/lib/goldmine/scan';
import { isAuthorizedScheduledScan } from '@/lib/goldmine/scheduled-auth';

const noStore = { 'Cache-Control': 'no-store' };
const LOCK_ID = 'goldmine:scan';

async function scan(request: Request, mode: 'daily' | 'detection'): Promise<Response> {
  if (!isAuthorizedScheduledScan(request)) {
    return Response.json({ error: 'Not authorized.' }, { status: 401, headers: noStore });
  }
  let lock: string | null = null;
  try {
    const database = db();
    lock = await acquireLock(LOCK_ID, SCAN_LOCK_TTL_MS);
    if (!lock) return Response.json({ status: 'busy', candidates: [] }, { headers: noStore });
    const result = mode === 'daily'
      ? await runGoldmineScan(database, Date.now())
      : await runGoldmineDetection(database, Date.now());
    return Response.json(result, { headers: noStore });
  } catch (error) {
    reportFailure('goldmine', 'scheduled-scan', error);
    return Response.json({ error: 'Goldmine scan failed.' }, { status: 503, headers: noStore });
  } finally {
    if (lock) await releaseLock(LOCK_ID, lock).catch(error => reportFailure('goldmine', 'release-lock', error));
  }
}

export async function GET(request: Request) {
  return scan(request, 'daily');
}

export async function POST(request: Request) {
  return scan(request, 'detection');
}
