// Automated Goldmine scans (Stage 03C candidate entry point). Same pipeline and shared `goldmine:scan`
// lock as the signed-in POST /api/goldmine route, but authorized by a dedicated secret instead of a
// ChatGPT session and same-origin check: an automated caller has neither. Fails closed - see
// lib/goldmine/scheduled-auth.ts - so an unconfigured GOLDMINE_CRON_SECRET never authorizes a scan.
//
// Nothing here wires an actual periodic trigger. Whether this endpoint (or the Worker's native
// `scheduled` handler) can be invoked automatically in production depends on platform support that is
// not confirmed from this repository - see docs/goldmine-intelligence.md section 6 and
// docs/deployment-runbook.md.
import {reportFailure} from '@/lib/diagnostics';
import {acquireLock, db, releaseLock} from '@/lib/research-db';
import {DISCLAIMER, MODEL_VERSION} from '@/lib/goldmine/score';
import {runGoldmineScan} from '@/lib/goldmine/scan';
import {authorizeScheduledScan} from '@/lib/goldmine/scheduled-auth';

const noStore = {'Cache-Control': 'no-store'};
const LOCK_ID = 'goldmine:scan';

export async function POST(request: Request) {
  if (!await authorizeScheduledScan(request)) return Response.json({error: 'Unauthorized.'}, {status: 401, headers: noStore});
  let lock: string | null = null;
  try {
    const database = db();
    lock = await acquireLock(LOCK_ID);
    if (!lock) return Response.json({status: 'busy', candidates: []}, {headers: noStore});
    const result = await runGoldmineScan(database, Date.now());
    return Response.json({modelVersion: MODEL_VERSION, ...result, disclaimer: DISCLAIMER}, {headers: noStore});
  } catch (error) {
    reportFailure('goldmine', 'scheduled-scan', error);
    return Response.json({error: 'Goldmine scan failed.'}, {status: 503, headers: noStore});
  } finally {
    if (lock) await releaseLock(LOCK_ID, lock).catch(error => reportFailure('goldmine', 'release-lock', error));
  }
}
