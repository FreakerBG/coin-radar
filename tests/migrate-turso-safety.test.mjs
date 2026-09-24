// Protections that the *production* Turso migration command must enforce, and the schema
// compatibility that the application actually depends on.
//
// tests/migrate-turso.test.mjs proves applyTursoMigrations() applies the journal correctly. This
// file covers the things that were not enforced on the path that reaches a real database:
// `npm run db:migrate:turso` selected its migrations with readMigrations(), which only checks that
// the journal is internally consistent. checkLock()/verifyMigrations() - the check that a migration
// already applied to a production database was never rewritten - ran on the Cloudflare build only.
// So a rewritten locked migration was refused by `npm run build` and accepted by the one command
// that applies migrations to production Turso, and `npm run build:vercel` did not check at all.
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { checkLock, migrationsDir, readMigrations, verifyMigrations } from '../scripts/migrations.mjs';
import { applyTursoMigrations, appliedTursoMigrations } from '../scripts/migrate-turso.mjs';

const migrations = readMigrations();
const tags = migrations.map(migration => migration.tag);

// A throwaway copy of drizzle/ so a test can corrupt a migration without touching the repository.
function migrationsCopy() {
  const dir = mkdtempSync(path.join(tmpdir(), 'coin-radar-migrations-'));
  mkdirSync(path.join(dir, 'meta'), { recursive: true });
  for (const name of readdirSync(migrationsDir)) {
    if (name.endsWith('.sql')) copyFileSync(path.join(migrationsDir, name), path.join(dir, name));
  }
  for (const name of readdirSync(path.join(migrationsDir, 'meta'))) {
    copyFileSync(path.join(migrationsDir, 'meta', name), path.join(dir, 'meta', name));
  }
  return dir;
}

describe('the production Turso migration command enforces the immutable-migration lock', () => {
  test('the committed migrations satisfy the lock as they stand', () => {
    assert.deepEqual(checkLock(readMigrations()), []);
    assert.deepEqual(verifyMigrations().map(m => m.tag), tags);
  });

  test('rewriting an already-locked migration is refused, and refused the same way the build refuses it', () => {
    // The bypass: readMigrations() accepts this happily, so the command that applies migrations to
    // production Turso used to accept it too. verifyMigrations() is what notices.
    const dir = migrationsCopy();
    const target = path.join(dir, `${tags[0]}.sql`);
    writeFileSync(target, readFileSync(target, 'utf8') + '\n--> statement-breakpoint\nCREATE TABLE sneaked_in (id TEXT PRIMARY KEY);\n');

    assert.ok(readMigrations({ dir }).length, 'readMigrations alone still accepts the rewritten history');

    const problems = checkLock(readMigrations({ dir }));
    assert.ok(
      problems.some(problem => problem.includes(`${tags[0]}.sql changed after it was locked`)),
      `expected an immutability problem, got: ${problems.join(' | ')}`,
    );
    assert.throws(() => verifyMigrations({ dir }), /changed after it was locked/);
  });

  test('removing or renaming a locked migration is refused', () => {
    const dir = migrationsCopy();
    const journalFile = path.join(dir, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalFile, 'utf8'));
    journal.entries.pop();
    writeFileSync(journalFile, JSON.stringify(journal, null, 2));
    assert.throws(() => verifyMigrations({ dir }), /locked but no longer listed|is not listed in meta/);
  });
});

describe('migration behaviour against a real libSQL database', () => {
  test('a migrated database reopened from a file still reports the same applied migrations', async () => {
    // ":memory:" cannot show that tracking survives reopening; a file database can.
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'coin-radar-turso-')), 'db.sqlite');
    const url = 'file:' + file.split(path.sep).join('/');

    const first = createClient({ url });
    assert.deepEqual(await applyTursoMigrations(first, migrations), tags);
    first.close();

    const second = createClient({ url });
    assert.deepEqual(await appliedTursoMigrations(second), tags.map(tag => `${tag}.sql`));
    assert.deepEqual(await applyTursoMigrations(second, migrations), [], 'reopening does not re-apply anything');
    second.close();
  });

  test('an upgrade from an older schema version preserves rows already in the database', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'coin-radar-turso-')), 'db.sqlite');
    const url = 'file:' + file.split(path.sep).join('/');

    // Stop at the first migration, write representative data, then finish migrating.
    const first = createClient({ url });
    await applyTursoMigrations(first, migrations.slice(0, 1));
    await first.execute({
      sql: 'INSERT INTO research_accounts (user_id, config) VALUES (?, ?)',
      args: ['owner', JSON.stringify({ maxPositionUsd: 100 })],
    });
    first.close();

    const second = createClient({ url });
    assert.deepEqual(await applyTursoMigrations(second, migrations), tags.slice(1), 'only the pending migrations run');
    const row = await second.execute({ sql: 'SELECT config FROM research_accounts WHERE user_id = ?', args: ['owner'] });
    assert.equal(row.rows.length, 1, 'the pre-existing row survived the upgrade');
    assert.deepEqual(JSON.parse(row.rows[0][0]), { maxPositionUsd: 100 });
    second.close();
  });

  test('an unknown migration recorded in the tracking table does not stop the known ones applying', async () => {
    const client = createClient({ url: ':memory:' });
    await applyTursoMigrations(client, []);          // creates the tracking table only
    await client.execute({ sql: 'INSERT INTO _turso_migrations (name) VALUES (?)', args: ['9999_from_the_future.sql'] });
    assert.deepEqual(await applyTursoMigrations(client, migrations), tags);
    client.close();
  });

  test('a second migration run against a database already being migrated fails loudly rather than corrupting it', async () => {
    // Concurrency is not coordinated: the tracking table's UNIQUE(name) is what stops a double
    // apply. Two runners racing produce an error from the loser, never two applications of one
    // migration. Simulated by recording a migration as applied out from under an in-flight run.
    const client = createClient({ url: ':memory:' });
    await applyTursoMigrations(client, migrations);
    const before = await appliedTursoMigrations(client);

    await assert.rejects(
      () => applyTursoMigrations(client, [...migrations, { tag: '9002_conflict_probe', statements: ['CREATE TABLE research_accounts (x TEXT)'] }]),
      /Migration 9002_conflict_probe\.sql failed/,
    );
    assert.deepEqual(await appliedTursoMigrations(client), before, 'the failed run recorded nothing');
    client.close();
  });

  test('errors name the migration without echoing credentials or connection details', async () => {
    const client = createClient({ url: ':memory:' });
    const broken = { tag: '9003_broken_probe', statements: ['INSERT INTO nope VALUES (1)'] };
    await assert.rejects(() => applyTursoMigrations(client, [broken]), error => {
      assert.match(error.message, /^Migration 9003_broken_probe\.sql failed:/);
      for (const secret of ['authToken', 'auth_token', 'libsql://', 'TURSO_AUTH_TOKEN']) {
        assert.equal(error.message.includes(secret), false, `error text leaked ${secret}`);
      }
      return true;
    });
    client.close();
  });
});

describe('the migrated schema matches what the application actually queries', () => {
  test('the real queries the app issues against research_locks run on the migrated schema', async () => {
    // The lock query is the one with SQLite-specific syntax (ON CONFLICT ... RETURNING) that has to
    // behave identically on libSQL for lib/research-db.ts to work at all.
    const client = createClient({ url: ':memory:' });
    await applyTursoMigrations(client, migrations);

    const now = Date.now();
    const acquire = (owner, expires) => client.execute({
      sql: 'INSERT INTO research_locks (id, owner, expires) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expires = excluded.expires WHERE research_locks.expires < ? RETURNING owner',
      args: ['goldmine:scan', owner, expires, now],
    });

    assert.equal((await acquire('first', now + 300_000)).rows[0][0], 'first', 'an uncontended lock is taken');
    assert.equal((await acquire('second', now + 300_000)).rows.length, 0, 'a held, unexpired lock is not taken');

    // Once the lease has expired, the next caller may take it - which is exactly why the lease has to
    // outlive the work it guards (lib/goldmine/scan.ts SCAN_LOCK_TTL_MS).
    const later = now + 400_000;
    const afterExpiry = await client.execute({
      sql: 'INSERT INTO research_locks (id, owner, expires) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expires = excluded.expires WHERE research_locks.expires < ? RETURNING owner',
      args: ['goldmine:scan', 'third', later + 300_000, later],
    });
    assert.equal(afterExpiry.rows[0][0], 'third');

    // releaseLock only deletes a row this owner still holds.
    const wrongOwner = await client.execute({ sql: 'DELETE FROM research_locks WHERE id = ? AND owner = ?', args: ['goldmine:scan', 'first'] });
    assert.equal(Number(wrongOwner.rowsAffected), 0, 'a stale owner cannot release the current holder');
    const rightOwner = await client.execute({ sql: 'DELETE FROM research_locks WHERE id = ? AND owner = ?', args: ['goldmine:scan', 'third'] });
    assert.equal(Number(rightOwner.rowsAffected), 1);

    client.close();
  });

  test('the json_each signal insert the scan pipeline uses works on the migrated schema', async () => {
    // recordSignals() inserts through json_each(?) and reads meta.changes to count new rows. If
    // either behaved differently on libSQL, every scan would silently record nothing.
    const client = createClient({ url: ':memory:' });
    await applyTursoMigrations(client, migrations);

    const rows = [1, 2].map(n => ({
      id: 'sig-' + n, address: 'addr-' + n, pair: 'pair-' + n, symbol: 'SYM', modelVersion: 'v2',
      state: 'WATCH', score: 70, opportunity: 0, detectedAt: 1_700_000_000_000, detectedPrice: 0.5,
      snapshot: '{}', assessment: '{}',
    }));
    const insert = payload => client.execute({
      sql: "INSERT OR IGNORE INTO goldmine_signals (id, address, pair, symbol, model_version, state, score, opportunity, detected_at, detected_price, snapshot, assessment) SELECT json_extract(value, '$.id'), json_extract(value, '$.address'), json_extract(value, '$.pair'), json_extract(value, '$.symbol'), json_extract(value, '$.modelVersion'), json_extract(value, '$.state'), json_extract(value, '$.score'), json_extract(value, '$.opportunity'), json_extract(value, '$.detectedAt'), json_extract(value, '$.detectedPrice'), json_extract(value, '$.snapshot'), json_extract(value, '$.assessment') FROM json_each(?)",
      args: [JSON.stringify(payload)],
    });

    assert.equal(Number((await insert(rows)).rowsAffected), 2);
    assert.equal(Number((await insert(rows)).rowsAffected), 0, 'INSERT OR IGNORE makes a repeat of the same ids a no-op');

    // ...but a re-scan at a different instant derives different ids, so the same token IS recorded
    // twice. That is why two scans must never overlap - see lib/goldmine/scan.ts SCAN_LOCK_TTL_MS.
    const laterScan = rows.map(row => ({ ...row, id: row.id + '-later', detectedAt: row.detectedAt + 1000 }));
    assert.equal(Number((await insert(laterScan)).rowsAffected), 2, 'a concurrent scan would duplicate these rows');

    client.close();
  });
});
