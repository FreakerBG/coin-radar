// GET /api/health: a signed-in, read-only D1 and schema check. Responses stay coarse; the failing
// table and error are only in the failure record. No provider is contacted.
import assert from 'node:assert/strict';
import {beforeEach, test} from 'node:test';
import {body, createD1, failures, installFetch, offlineFetch, runtime, signIn, signOut, startClock} from './helpers/harness.mjs';

const {GET} = await import('../app/api/health/route.ts');
const {requiredTables} = await import('../lib/schema-requirements.ts');
const tableCount = Object.keys(requiredTables).length;

let d1;
beforeEach(() => {
  startClock();
  d1 = createD1();
  runtime.env.DB = d1;
  installFetch(offlineFetch);
  failures.length = 0;
  signIn('user-a');
});

test('requires sign-in before touching storage', async () => {
  signOut();
  const response = await GET();
  assert.deepEqual([response.status, response.headers.get('Cache-Control')], [401, 'no-store']);
  assert.deepEqual([d1.queries, failures], [[], []]);
});

test('a binding that throws while preparing a probe reports storage unavailable', async () => {
  runtime.env.DB = {prepare() { throw new Error('D1 binding rejected the statement'); }};
  const response = await GET();
  assert.deepEqual([response.status, response.headers.get('Cache-Control'), await body(response)], [503, 'no-store', {status: 'degraded', storage: 'unavailable'}]);
  assert.equal(failures.length, tableCount);
});

test('a schema error wrapped as a cause is a schema error; any other rejection is a storage error', async () => {
  d1.beforeQuery = sql => { if (sql.includes('FROM social_usage')) throw new Error('D1_ERROR', {cause: new Error('no such table: social_usage: SQLITE_ERROR')}); };
  const wrapped = await GET();
  assert.deepEqual([wrapped.status, await body(wrapped)], [503, {status: 'degraded', storage: 'ok', schema: 'incompatible'}]);

  d1.beforeQuery = sql => { if (sql.includes('FROM social_usage')) throw 'no such table: social_usage'; };
  const thrownValue = await GET();
  assert.deepEqual([thrownValue.status, await body(thrownValue)], [503, {status: 'degraded', storage: 'unavailable'}]);
});

test('a migrated database is compatible, checked with one read-only probe per required table', async () => {
  const response = await GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await body(response), {status: 'ok', storage: 'ok', schema: 'compatible', checkedAt: new Date().toISOString()});
  assert.equal(d1.queries.length, tableCount);
  assert.ok(d1.queries.every(sql => /^SELECT [\w, ]+ FROM \w+ LIMIT 0$/.test(sql)), d1.queries.join('\n'));
  assert.deepEqual(failures, []);
});

test('a missing D1 binding reports storage unavailable', async () => {
  delete runtime.env.DB;
  const response = await GET();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await body(response), {status: 'degraded', storage: 'unavailable'});
  assert.deepEqual(failures.map(failure => [failure.route, failure.operation, failure.level]), [['health', 'binding', 'error']]);
});

test('a missing table or column reports an incompatible schema without naming it in the response', async () => {
  d1.sqlite.exec('ALTER TABLE research_locks DROP COLUMN expires; DROP TABLE social_usage;');
  const response = await GET();
  const data = await body(response);
  assert.equal(response.status, 503);
  assert.deepEqual(data, {status: 'degraded', storage: 'ok', schema: 'incompatible'});
  assert.deepEqual(failures.map(failure => failure.operation).sort(), ['probe:research_locks', 'probe:social_usage']);
  assert.match(failures.find(failure => failure.operation === 'probe:research_locks').error.message, /no such column: expires/);
  assert.match(failures.find(failure => failure.operation === 'probe:social_usage').error.message, /no such table: social_usage/);
});

test('a storage error reports storage unavailable even when other probes find schema problems', async () => {
  d1.sqlite.exec('DROP TABLE social_usage');
  d1.beforeQuery = sql => { if (sql.includes('FROM research_accounts')) throw new Error('D1_ERROR: Network connection lost.'); };
  const response = await GET();
  assert.equal(response.status, 503);
  assert.deepEqual(await body(response), {status: 'degraded', storage: 'unavailable'});
  assert.deepEqual(failures.map(failure => [failure.operation, failure.error.message]).sort(), [
    ['probe:research_accounts', 'D1_ERROR: Network connection lost.'],
    ['probe:social_usage', 'no such table: social_usage'],
  ]);
});
