// Fresh database: every real migration applied in order to a new temporary database file, checked
// against what the application requires, and exercised through the real routes.
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {describe, test} from 'node:test';
import {readMigrations, splitStatements} from '../../scripts/migrations.mjs';
import {addresses, body, createD1, installFetch, jsonRequest, runtime, signIn, startClock} from '../helpers/harness.mjs';
import {applicationTables, appliedMigrations, applyMigrations, createTempDatabase} from '../helpers/migration-db.mjs';
import {applicationStatements, drizzleModelProblems, requiredTables, schemaContractProblems, statementProblems} from './schema-contract.mjs';

const migrations = readMigrations();
const tags = migrations.map(migration => migration.tag);

function migratedDatabase(t, list = migrations) {
  const database = createTempDatabase();
  t.after(() => database.cleanup());
  applyMigrations(database.sqlite, list);
  return database;
}

describe('a fresh database built from every migration', () => {
  test('applies each migration once, in journal order, and records it', t => {
    const database = createTempDatabase();
    t.after(() => database.cleanup());
    assert.deepEqual(applyMigrations(database.sqlite), tags);
    assert.deepEqual(applyMigrations(database.sqlite), []);
    const sqlite = database.reopen();
    assert.deepEqual(appliedMigrations(sqlite), tags.map(tag => `${tag}.sql`));
    assert.deepEqual(applyMigrations(sqlite), [], 'reopening the file finds nothing pending');
  });

  test('can stop at every intermediate schema version', t => {
    for (let count = 1; count <= migrations.length; count++) {
      const {sqlite} = migratedDatabase(t, migrations.slice(0, count));
      assert.deepEqual(appliedMigrations(sqlite), tags.slice(0, count).map(tag => `${tag}.sql`));
    }
  });

  test('meets the schema contract derived from the application', t => {
    const {sqlite} = migratedDatabase(t);
    assert.deepEqual(schemaContractProblems(sqlite), []);
  });

  test('compiles every SQL statement the application prepares', t => {
    const {sqlite} = migratedDatabase(t);
    const {statements, unchecked} = applicationStatements();
    assert.deepEqual(unchecked, [], 'extend applicationStatements() in tests/migrations/schema-contract.mjs');
    for (const table of Object.keys(requiredTables)) {
      assert.ok(statements.some(({sql}) => new RegExp(`\\b${table}\\b`).test(sql)), `no application statement uses ${table}`);
    }
    assert.deepEqual(statementProblems(sqlite, statements), []);
  });

  test('lib/schema-requirements.ts names every table and column the application SQL uses', () => {
    // A database with only the required tables, columns and keys: any statement that needs more
    // would pass against the migrations while GET /api/health never probes it.
    const sqlite = new DatabaseSync(':memory:');
    for (const [table, spec] of Object.entries(requiredTables)) {
      sqlite.exec(`CREATE TABLE ${table} (${Object.entries(spec.columns).map(([name, type]) => `${name} ${type}`).join(', ')}, UNIQUE (${spec.key.join(', ')}))`);
    }
    assert.deepEqual(statementProblems(sqlite), []);
    sqlite.close();
  });

  test('matches the db/schema.ts model that npm run db:generate diffs against', async t => {
    const {sqlite} = migratedDatabase(t);
    assert.deepEqual(await drizzleModelProblems(sqlite), []);
  });

  test('serves reads and writes through the real routes and keeps them after reopening', async t => {
    startClock();
    const database = migratedDatabase(t);
    runtime.env.DB = createD1(database.sqlite);
    runtime.env.X_BEARER_TOKEN = 'offline-test-credential';
    installFetch(url => url.startsWith('https://api.x.com/')
      ? Response.json({data: [{id: '1', text: 'Fresh post', author_id: 'author-1', created_at: new Date().toISOString()}]})
      : Response.json({pairs: [{chainId: 'solana', pairAddress: addresses.pairA, baseToken: {address: addresses.tokenA}, priceUsd: '0.5', liquidity: {usd: 100000}}]}));
    const portfolio = await import('../../app/api/portfolio/route.ts');
    const monitor = await import('../../app/api/monitor/route.ts');
    const social = await import('../../app/api/social/route.ts');
    const health = await import('../../app/api/health/route.ts');
    const post = (route, path, payload) => route.POST(jsonRequest(path, {method: 'POST', body: payload}));
    const config = {bankroll: 1000, riskPct: 2, maxAllocationPct: 5, takeProfitPct: 40, stopPct: 20, trailingPct: 15, liquidityDropPct: 30, xDailyRequests: 3};
    const id = '44444444-4444-4444-8444-444444444444';

    signIn('user-a');
    assert.equal((await body(await health.GET())).schema, 'compatible');
    assert.deepEqual(await body(await post(portfolio, '/api/portfolio', {action: 'config', config})), {ok: true});
    const position = {id, address: addresses.tokenA, pair: addresses.pairA, symbol: 'FIX', entryPrice: 1, amount: 100, entryLiquidity: 100000};
    assert.deepEqual(await body(await post(portfolio, '/api/portfolio', {action: 'position', position})), {ok: true});
    assert.deepEqual((await body(await post(monitor, '/api/monitor', {}))).newEvents.map(event => event.kind), ['loss_threshold']);
    assert.equal((await body(await post(social, '/api/social', {address: addresses.tokenA}))).usedToday, 1);

    runtime.env.DB = createD1(database.reopen());
    const reloaded = await body(await portfolio.GET());
    assert.deepEqual([reloaded.config, reloaded.positions.map(p => [p.id, p.lastPrice]), reloaded.events.map(event => event.kind)],
      [config, [[id, 0.5]], ['loss_threshold']]);
    const cached = await body(await social.GET(jsonRequest(`/api/social?address=${addresses.tokenA}`)));
    assert.deepEqual([cached.cached, cached.stale, cached.usedToday, cached.posts.length], [true, false, 1, 1]);
  });

  test('uses a separate temporary file per database and removes it on cleanup', () => {
    const first = createTempDatabase();
    const second = createTempDatabase();
    try {
      assert.notEqual(first.directory, second.directory);
      applyMigrations(first.sqlite);
      assert.deepEqual([appliedMigrations(first.sqlite).length, appliedMigrations(second.sqlite).length], [migrations.length, 0]);
    } finally {
      first.cleanup();
      second.cleanup();
    }
    assert.deepEqual([existsSync(first.directory), existsSync(second.directory)], [false, false]);
  });
});

// Harness self-tests: synthetic migrations exist only in memory here, never in drizzle/.
describe('failures are reported clearly', () => {
  const synthetic = (tag, statements) => ({tag, statements: splitStatements(statements.join('\n--> statement-breakpoint\n'))});

  test('a migration that cannot be applied is named, rolled back and left unrecorded', t => {
    const database = createTempDatabase();
    t.after(() => database.cleanup());
    const broken = synthetic('9001_broken_probe', ['CREATE TABLE harness_probe (id text PRIMARY KEY)', 'INSERT INTO missing_table VALUES (1)']);
    assert.throws(() => applyMigrations(database.sqlite, [...migrations, broken]), {message: /^Migration 9001_broken_probe\.sql failed: no such table: missing_table/});
    assert.deepEqual(appliedMigrations(database.sqlite), tags.map(tag => `${tag}.sql`), 'earlier migrations stay applied');
    assert.equal(applicationTables(database.sqlite).includes('harness_probe'), false, 'no partial schema is left behind');
  });

  test('a schema missing required tables, columns or constraints fails every schema check', async t => {
    const {sqlite} = migratedDatabase(t, [synthetic('9002_incompatible_probe', [
      'CREATE TABLE research_accounts (user_id text NOT NULL, config text NOT NULL, revision integer DEFAULT 0 NOT NULL)',
      'CREATE TABLE research_positions (id text PRIMARY KEY NOT NULL, user_id text, data text NOT NULL, closed_at text NOT NULL, revision integer NOT NULL)',
      'CREATE TABLE social_cache (address text PRIMARY KEY NOT NULL, user_id text, data text NOT NULL, fetched_at text NOT NULL)',
    ])]);
    const contract = schemaContractProblems(sqlite);
    for (const expected of [
      'missing table research_events',
      'research_accounts needs a PRIMARY KEY or UNIQUE constraint on exactly (user_id)',
      'research_positions.user_id must be NOT NULL',
      'research_positions.closed_at must be nullable',
      'social_cache.fetched_at has TEXT affinity, expected INTEGER',
      'social_cache is shared by every user; new column user_id needs a cross-user isolation review',
    ]) assert.ok(contract.includes(expected), `expected "${expected}" in:\n${contract.join('\n')}`);
    assert.ok(contract.some(problem => problem.startsWith("research_positions: the application's insert of (id, user_id, data) fails: NOT NULL constraint failed")), contract.join('\n'));

    const statements = statementProblems(sqlite);
    assert.ok(statements.some(problem => problem.includes('ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint')), statements.join('\n'));
    assert.ok(statements.some(problem => problem.includes('no such table: research_locks')), statements.join('\n'));

    const model = await drizzleModelProblems(sqlite);
    assert.ok(model.includes('db/schema.ts defines table research_events but no migration creates it (run npm run db:generate)'), model.join('\n'));
    assert.ok(model.includes('column social_cache.user_id is created by migrations but missing from db/schema.ts'), model.join('\n'));

    // The runtime health check sees the missing tables, though not the constraint problems above.
    const {GET} = await import('../../app/api/health/route.ts');
    runtime.env.DB = createD1(sqlite);
    signIn('user-a');
    const response = await GET();
    assert.deepEqual([response.status, await body(response)], [503, {status: 'degraded', storage: 'ok', schema: 'incompatible'}]);
  });
});
