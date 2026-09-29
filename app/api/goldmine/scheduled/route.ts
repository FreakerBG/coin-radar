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
import { reportFailure, reportScanOutcome, type ScanOutcomeDetails } from '@/lib/diagnostics';
import { acquireLock, db, releaseLock } from '@/lib/research-db';
import { runGoldmineDetection, runGoldmineScan, SCAN_LOCK_TTL_MS, type GoldmineScanResult } from '@/lib/goldmine/scan';
import { isAuthorizedScheduledScan } from '@/lib/goldmine/scheduled-auth';

const noStore = { 'Cache-Control': 'no-store' };
const LOCK_ID = 'goldmine:scan';

// Counts and enums only, copied field by field so nothing else from the result (candidates, addresses,
// provider warnings) can ever reach the log line.
function outcomeDetails(result: GoldmineScanResult, started: number): ScanOutcomeDetails {
  const safety = result.safety;
  return {
    durationMs: Date.now() - started,
    candidates: result.candidates.length,
    opportunities: result.opportunities ?? 0,
    newSignals: result.tracking.newSignals,
    outcomesSettled: result.tracking.outcomes !== null,
    ...(safety ? { safety: {
      eligible: safety.eligible, verified: safety.verified, unsafe: safety.unsafe, unavailable: safety.unavailable,
      requests: safety.requests, cacheHits: safety.cacheHits, rateLimited: safety.rateLimited, cooldown: safety.cooldown, unchecked: safety.unchecked,
    } } : {}),
  };
}

async function scan(request: Request, mode: 'daily' | 'detection'): Promise<Response> {
  if (!isAuthorizedScheduledScan(request)) {
    return Response.json({ error: 'Not authorized.' }, { status: 401, headers: noStore });
  }
  let lock: string | null = null;
  const started = Date.now();
  try {
    const database = db();
    lock = await acquireLock(LOCK_ID, SCAN_LOCK_TTL_MS);
    if (!lock) {
      reportScanOutcome('goldmine-scheduled', mode, 'busy', { durationMs: Date.now() - started });
      return Response.json({ status: 'busy', candidates: [] }, { headers: noStore });
    }
    const result = mode === 'daily'
      ? await runGoldmineScan(database, Date.now())
      : await runGoldmineDetection(database, Date.now());
    reportScanOutcome('goldmine-scheduled', mode, result.status, outcomeDetails(result, started));
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
