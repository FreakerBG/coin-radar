// lib/turso-db.ts implements the exact D1-shaped surface the app calls against `env.DB`:
// prepare(sql).bind(...args).first()/.all()/.run(), plus result.meta.changes after .run(). Proven
// here against @libsql/client's local ":memory:" mode - no network, no real Turso account, matching
// what the migration owner instructions require (no real credentials exist yet for this project).
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { createTursoDatabase } from '../lib/turso-db.ts';

let database;
afterEach(() => {
  database = undefined;
});

function fresh() {
  database = createTursoDatabase({ url: ':memory:', authToken: '' });
  return database;
}

describe('createTursoDatabase: D1-shaped prepare/bind/first/all/run', () => {
  test('prepare().bind().run() reports rows changed via meta.changes, like D1', async () => {
    const db = fresh();
    await db.prepare('CREATE TABLE widgets (id TEXT PRIMARY KEY, name TEXT NOT NULL)').run();
    const inserted = await db.prepare('INSERT INTO widgets (id, name) VALUES (?, ?)').bind('a', 'Alpha').run();
    assert.deepEqual(inserted, { success: true, meta: { changes: 1 } });

    const noMatch = await db.prepare('UPDATE widgets SET name = ? WHERE id = ?').bind('Nope', 'missing').run();
    assert.equal(noMatch.meta.changes, 0);
  });

  test('prepare().bind().first() returns a plain object or null, matching D1 first()', async () => {
    const db = fresh();
    await db.prepare('CREATE TABLE widgets (id TEXT PRIMARY KEY, name TEXT NOT NULL)').run();
    await db.prepare('INSERT INTO widgets (id, name) VALUES (?, ?)').bind('a', 'Alpha').run();

    const row = await db.prepare('SELECT id, name FROM widgets WHERE id = ?').bind('a').first();
    assert.deepEqual(row, { id: 'a', name: 'Alpha' });
    // A plain object: JSON.stringify and spread work the same way call sites already rely on for D1 rows.
    assert.deepEqual({ ...row }, { id: 'a', name: 'Alpha' });
    assert.equal(JSON.stringify(row), '{"id":"a","name":"Alpha"}');

    assert.equal(await db.prepare('SELECT id FROM widgets WHERE id = ?').bind('missing').first(), null);
  });

  test('prepare().bind().all() returns {results, success, meta}, matching D1 all()', async () => {
    const db = fresh();
    await db.prepare('CREATE TABLE widgets (id TEXT PRIMARY KEY, name TEXT NOT NULL)').run();
    await db.prepare('INSERT INTO widgets (id, name) VALUES (?, ?)').bind('a', 'Alpha').run();
    await db.prepare('INSERT INTO widgets (id, name) VALUES (?, ?)').bind('b', 'Beta').run();

    const all = await db.prepare('SELECT id, name FROM widgets ORDER BY id').all();
    assert.deepEqual(all, {
      results: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }],
      success: true,
      meta: {},
    });
  });

  test('prepare(sql) works without a bind() call, like the health route\'s database.prepare(sql).all()', async () => {
    const db = fresh();
    await db.prepare('CREATE TABLE widgets (id TEXT PRIMARY KEY)').run();
    const all = await db.prepare('SELECT id FROM widgets').all();
    assert.deepEqual(all.results, []);
  });

  test('SQLite-specific syntax (ON CONFLICT ... RETURNING) runs unchanged, as the D1 call sites need', async () => {
    const db = fresh();
    await db.prepare('CREATE TABLE locks (id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL)').run();
    const first = await db.prepare(
      'INSERT INTO locks (id, owner, expires) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expires = excluded.expires WHERE locks.expires < ? RETURNING owner',
    ).bind('goldmine:scan', 'owner-a', 1000, 0).first();
    assert.deepEqual(first, { owner: 'owner-a' });

    // A second attempt while the lock has not expired yields no row (the WHERE clause excludes it).
    const second = await db.prepare(
      'INSERT INTO locks (id, owner, expires) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expires = excluded.expires WHERE locks.expires < ? RETURNING owner',
    ).bind('goldmine:scan', 'owner-b', 2000, 0).first();
    assert.equal(second, null);
  });

  test('bind() is immutable per call: rebinding the same prepared statement does not leak args across calls', async () => {
    const db = fresh();
    await db.prepare('CREATE TABLE widgets (id TEXT PRIMARY KEY, name TEXT NOT NULL)').run();
    const statement = db.prepare('INSERT INTO widgets (id, name) VALUES (?, ?)');
    await statement.bind('a', 'Alpha').run();
    await statement.bind('b', 'Beta').run();
    const all = await db.prepare('SELECT id, name FROM widgets ORDER BY id').all();
    assert.deepEqual(all.results, [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]);
  });
});
