// scripts/migrate-turso.mjs applies drizzle/*.sql to a Turso (libSQL) database in journal order,
// tracking applied migrations in `_turso_migrations`. Proven here against @libsql/client's local
// ":memory:" mode: no real Turso account exists for this project yet, so this is the only way to
// prove the runner is correct before a human provisions real credentials.
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { describe, test } from 'node:test';
import { readMigrations } from '../scripts/migrations.mjs';
import { applyTursoMigrations, appliedTursoMigrations, TRACKING_TABLE } from '../scripts/migrate-turso.mjs';

const migrations = readMigrations();
const tags = migrations.map(migration => migration.tag);

async function freshClient() {
  return createClient({ url: ':memory:' });
}

describe('applyTursoMigrations', () => {
  test('applies every real migration once, in journal order, and records it', async () => {
    const client = await freshClient();
    assert.deepEqual(await applyTursoMigrations(client, migrations), tags);
    assert.deepEqual(await applyTursoMigrations(client, migrations), [], 'nothing left pending');
    assert.deepEqual(await appliedTursoMigrations(client), tags.map(tag => `${tag}.sql`));
    client.close();
  });

  test('can stop at every intermediate schema version', async () => {
    for (let count = 1; count <= migrations.length; count++) {
      const client = await freshClient();
      const applied = await applyTursoMigrations(client, migrations.slice(0, count));
      assert.deepEqual(applied, tags.slice(0, count));
      assert.deepEqual(await appliedTursoMigrations(client), tags.slice(0, count).map(tag => `${tag}.sql`));
      client.close();
    }
  });

  test('creates the application tables the migrations describe', async () => {
    const client = await freshClient();
    await applyTursoMigrations(client, migrations);
    const tables = (await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).rows.map(row => row[0]);
    for (const table of ['research_accounts', 'research_positions', 'research_events', 'research_locks', 'social_cache', 'social_usage', 'goldmine_signals', 'goldmine_outcomes']) {
      assert.ok(tables.includes(table), `expected ${table} among ${tables.join(', ')}`);
    }
    client.close();
  });

  test('a migration that fails is named, rolled back, and leaves earlier migrations applied and recorded', async () => {
    const client = await freshClient();
    const broken = { tag: '9001_broken_probe', statements: ['CREATE TABLE harness_probe (id TEXT PRIMARY KEY)', 'INSERT INTO missing_table VALUES (1)'] };
    await assert.rejects(
      () => applyTursoMigrations(client, [...migrations, broken]),
      error => error.message.startsWith('Migration 9001_broken_probe.sql failed:'),
    );
    assert.deepEqual(await appliedTursoMigrations(client), tags.map(tag => `${tag}.sql`), 'earlier migrations stay applied');
    const tables = (await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'harness_probe'")).rows;
    assert.equal(tables.length, 0, 'no partial schema from the failed migration is left behind');
    client.close();
  });

  test('is idempotent: re-running against an already-migrated database applies nothing', async () => {
    const client = await freshClient();
    await applyTursoMigrations(client, migrations);
    const before = (await client.execute(`SELECT COUNT(*) AS n FROM ${TRACKING_TABLE}`)).rows[0][0];
    assert.deepEqual(await applyTursoMigrations(client, migrations), []);
    const after = (await client.execute(`SELECT COUNT(*) AS n FROM ${TRACKING_TABLE}`)).rows[0][0];
    assert.equal(before, after);
    client.close();
  });
});
