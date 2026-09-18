import {getChatGPTUser} from '@/app/chatgpt-auth';
import {reportFailure} from '@/lib/diagnostics';
import {db} from '@/lib/research-db';
import {schemaProbes} from '@/lib/schema-requirements';

const noStore = {'Cache-Control': 'no-store'};

function isSchemaError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const cause = error.cause instanceof Error ? error.cause.message : '';
  return /no such (table|column)/i.test(`${error.message} ${cause}`);
}

// Signed-in, read-only check that D1 is reachable and has every table and column the routes use.
// Each table is probed with SELECT ... LIMIT 0: no writes and no provider calls. The response stays
// coarse; which table failed, and why, is reported to Workers logs.
export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return Response.json({error: 'Sign in required.'}, {status: 401, headers: noStore});
  let database: D1Database;
  try {
    database = db();
  } catch (error) {
    reportFailure('health', 'binding', error);
    return Response.json({status: 'degraded', storage: 'unavailable'}, {status: 503, headers: noStore});
  }

  const probes = schemaProbes();
  // async, so a binding that throws synchronously while preparing is a rejected probe too.
  const results = await Promise.allSettled(probes.map(async probe => database.prepare(probe.sql).all()));
  const failures = results.flatMap((result, index) => result.status === 'rejected' ? [{table: probes[index].table, error: result.reason}] : []);
  for (const {table, error} of failures) reportFailure('health', `probe:${table}`, error);

  if (failures.some(({error}) => !isSchemaError(error))) {
    return Response.json({status: 'degraded', storage: 'unavailable'}, {status: 503, headers: noStore});
  }
  if (failures.length) {
    return Response.json({status: 'degraded', storage: 'ok', schema: 'incompatible'}, {status: 503, headers: noStore});
  }
  return Response.json({status: 'ok', storage: 'ok', schema: 'compatible', checkedAt: new Date().toISOString()}, {headers: noStore});
}
