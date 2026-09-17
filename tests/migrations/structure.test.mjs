// Migration history structure: journal, SQL files, snapshots and the immutability lock, plus the
// build gate and migration CLI that enforce them. Negative cases edit temporary copies only.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, test} from 'node:test';
import {
  lockEntry, MigrationCheckError, migrationLockFile, migrationsDir, projectRoot, readMigrations, verifyMigrations,
} from '../../scripts/migrations.mjs';

// A malformed journal stops this file at load with the full problem list; lock problems fail the first test.
const migrations = readMigrations();
const first = migrations[0].tag;

function temporaryDirectory(t, prefix) {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(directory, {recursive: true, force: true, maxRetries: 5, retryDelay: 50}));
  return directory;
}

// A temporary copy of drizzle/ and the lock that a test may break.
function historyCopy(t) {
  const root = temporaryDirectory(t, 'coin-radar-migrations-');
  const dir = path.join(root, 'drizzle');
  const lockFile = path.join(root, 'migrations.lock.json');
  cpSync(migrationsDir, dir, {recursive: true});
  cpSync(migrationLockFile, lockFile);
  const file = name => path.join(dir, name);
  const journal = () => JSON.parse(readFileSync(file('meta/_journal.json'), 'utf8'));
  const copy = {
    lockFile,
    file,
    editJournal(edit) {
      const current = journal();
      edit(current.entries);
      writeFileSync(file('meta/_journal.json'), JSON.stringify(current, null, 2));
    },
    // Adds a synthetic migration with a journal entry and chained snapshot, as db:generate would.
    append(tag, sql = 'CREATE TABLE harness_probe (id text PRIMARY KEY NOT NULL)') {
      const {entries} = journal();
      const number = String(entries.length).padStart(4, '0');
      const previous = JSON.parse(readFileSync(file(`meta/${String(entries.length - 1).padStart(4, '0')}_snapshot.json`), 'utf8'));
      writeFileSync(file(`${tag}.sql`), sql);
      writeFileSync(file(`meta/${number}_snapshot.json`), JSON.stringify({...previous, id: `probe-snapshot-${number}`, prevId: previous.id}, null, 2));
      copy.editJournal(list => list.push({idx: entries.length, version: '6', when: entries.at(-1).when + 1000, tag, breakpoints: true}));
    },
    lockAll: () => writeFileSync(lockFile, JSON.stringify({migrations: readMigrations({dir}).map(lockEntry)}, null, 2)),
    read: () => readMigrations({dir}),
    verify: () => verifyMigrations({dir, lockFile}),
  };
  return copy;
}

function assertRejected(copy, expected) {
  assert.throws(() => copy.verify(), error => {
    assert.ok(error instanceof MigrationCheckError, error.stack);
    if (expected instanceof RegExp) assert.match(error.message, expected);
    else assert.ok(error.message.includes(expected), `expected "${expected}" in:\n${error.message}`);
    return true;
  });
}

test('the committed history is well-formed and locked, and file order matches journal order', () => {
  assert.equal(verifyMigrations().length, migrations.length);
  const files = readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort();
  assert.deepEqual(files, migrations.map(migration => `${migration.tag}.sql`));
  assert.ok(migrations.every(migration => migration.statements.length > 0));
});

test('file-name tracking and journal-timestamp tracking choose the same pending migrations', () => {
  // Wrangler records applied file names; Drizzle's migrator applies entries newer than the last applied "when".
  for (let applied = 0; applied <= migrations.length; applied++) {
    const names = new Set(migrations.slice(0, applied).map(migration => migration.tag));
    const lastWhen = applied ? migrations[applied - 1].when : -Infinity;
    assert.deepEqual(
      migrations.filter(migration => migration.when > lastWhen).map(migration => migration.tag),
      migrations.filter(migration => !names.has(migration.tag)).map(migration => migration.tag),
    );
  }
});

describe('the migration check rejects an unsafe history', () => {
  test('duplicate, gapped or misnumbered journal entries', t => {
    const duplicate = historyCopy(t);
    duplicate.append('0001_probe');
    duplicate.editJournal(entries => { entries[1].idx = 0; });
    assertRejected(duplicate, 'journal entry 1 (0001_probe): idx is 0, expected 1');

    const gap = historyCopy(t);
    gap.append('0001_probe');
    gap.editJournal(entries => { entries[1].idx = 2; });
    assertRejected(gap, 'journal entry 1 (0001_probe): idx is 2, expected 1');

    const misnumbered = historyCopy(t);
    misnumbered.append('0002_probe');
    assertRejected(misnumbered, 'journal entry 1 (0002_probe): tag is numbered 0002, expected 0001');
  });

  test('duplicate migration numbers, unlisted SQL files and missing SQL files', t => {
    const duplicate = historyCopy(t);
    writeFileSync(duplicate.file('0000_duplicate_probe.sql'), 'CREATE TABLE harness_probe (id text)');
    assertRejected(duplicate, `duplicate migration number 0000: 0000_duplicate_probe.sql, ${first}.sql`);
    assertRejected(duplicate, /0000_duplicate_probe\.sql is not listed in meta\/_journal\.json/);

    const missing = historyCopy(t);
    missing.append('0001_probe');
    rmSync(missing.file('0001_probe.sql'));
    assertRejected(missing, /0001_probe\.sql is missing/);
  });

  test('a journal timestamp that is not newer, and disabled statement breakpoints', t => {
    const stale = historyCopy(t);
    stale.append('0001_probe');
    stale.editJournal(entries => { entries[1].when = entries[0].when; });
    assertRejected(stale, 'journal entry 1 (0001_probe): "when" must be an integer timestamp newer than the previous entry\'s');

    const combined = historyCopy(t);
    combined.editJournal(entries => { entries[0].breakpoints = false; });
    assertRejected(combined, `journal entry 0 (${first}): "breakpoints" must be true`);
  });

  test('empty statements, a broken snapshot chain and an unreadable journal', t => {
    const empty = historyCopy(t);
    empty.append('0001_probe', 'CREATE TABLE harness_probe (id text);\n--> statement-breakpoint\n-- nothing here\n');
    assertRejected(empty, /0001_probe\.sql: statement 2 is empty/);

    const chain = historyCopy(t);
    chain.append('0001_probe');
    const snapshot = chain.file('meta/0001_snapshot.json');
    writeFileSync(snapshot, JSON.stringify({...JSON.parse(readFileSync(snapshot, 'utf8')), prevId: 'unrelated'}));
    assertRejected(chain, "0001_probe: snapshot prevId does not point at the previous migration's snapshot");
    rmSync(snapshot);
    assertRejected(chain, /meta\/0001_snapshot\.json is missing/);

    const unreadable = historyCopy(t);
    writeFileSync(unreadable.file('meta/_journal.json'), '{"entries": [');
    assertRejected(unreadable, /cannot read .*meta\/_journal\.json/);
  });
});

describe('db/migrations.lock.json keeps published migrations immutable', () => {
  test('any edit to a locked SQL file, journal entry or snapshot is refused', t => {
    const edits = [
      [copy => writeFileSync(copy.file(`${first}.sql`), `${readFileSync(copy.file(`${first}.sql`), 'utf8')}\n`), `${first}.sql changed after it was locked`],
      [copy => copy.editJournal(entries => { entries[0].when += 1; }), `${first}: journal "when" changed after it was locked`],
      [copy => {
        const snapshot = copy.file('meta/0000_snapshot.json');
        writeFileSync(snapshot, readFileSync(snapshot, 'utf8').replace('"version": "6"', '"version": "6" '));
      }, `${first}: meta snapshot changed after it was locked`],
    ];
    for (const [edit, expected] of edits) {
      const copy = historyCopy(t);
      edit(copy);
      assertRejected(copy, expected);
    }
  });

  test('converting line endings is not an edit', t => {
    const copy = historyCopy(t);
    const file = copy.file(`${first}.sql`);
    const lf = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    for (const text of [lf, lf.replace(/\n/g, '\r\n')]) {
      writeFileSync(file, text);
      assert.equal(copy.verify().length, migrations.length);
    }
  });

  test('a locked migration cannot be renamed or removed', t => {
    const renamed = historyCopy(t);
    writeFileSync(renamed.lockFile, readFileSync(renamed.lockFile, 'utf8').replace(`"tag": "${first}"`, '"tag": "0000_original_name"'));
    assertRejected(renamed, `journal position 0 is ${first} but the lock records 0000_original_name`);

    const removed = historyCopy(t);
    removed.append('0001_probe');
    removed.lockAll();
    assert.equal(removed.verify().length, migrations.length + 1);
    removed.editJournal(entries => { entries.pop(); });
    rmSync(removed.file('0001_probe.sql'));
    rmSync(removed.file('meta/0001_snapshot.json'));
    assertRejected(removed, '0001_probe is locked but no longer listed in the journal');
  });

  test('a new migration is refused until its entry is appended to the lock', t => {
    const copy = historyCopy(t);
    copy.append('0001_probe');
    const entry = lockEntry(copy.read().at(-1));
    assertRejected(copy, `append ${JSON.stringify(entry)}`);
    const lock = JSON.parse(readFileSync(copy.lockFile, 'utf8'));
    writeFileSync(copy.lockFile, JSON.stringify({...lock, migrations: [...lock.migrations, entry]}, null, 2));
    assert.deepEqual(copy.verify().map(migration => migration.tag), [...migrations.map(migration => migration.tag), '0001_probe']);
  });
});

// A minimal copy of the project: enough for the build gate and migration CLI, without dependencies.
function projectCopy(t) {
  const root = temporaryDirectory(t, 'coin-radar-project-');
  for (const file of ['scripts/run-framework.mjs', 'scripts/execution-profile.mjs', 'scripts/migrations.mjs', 'scripts/db-migrations.mjs', 'db/migrations.lock.json', '.openai/hosting.json']) {
    mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
    cpSync(path.join(projectRoot, file), path.join(root, file));
  }
  cpSync(migrationsDir, path.join(root, 'drizzle'), {recursive: true});
  return root;
}
const runNode = (cwd, ...args) => spawnSync(process.execPath, args, {cwd, encoding: 'utf8'});

describe('enforcement outside the test suite', () => {
  test('npm run build refuses a rewritten migration before building anything', t => {
    const root = projectCopy(t);
    const sql = path.join(root, 'drizzle', `${first}.sql`);
    writeFileSync(sql, `${readFileSync(sql, 'utf8')}\n-- edited after publishing\n`);
    const refused = runNode(root, 'scripts/run-framework.mjs', 'build');
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, new RegExp(`Migration check failed:[\\s\\S]*${first}\\.sql changed after it was locked`));
    assert.equal(existsSync(path.join(root, 'dist')), false);

    // Restored, the check passes and the build reaches the framework, which this copy does not install.
    cpSync(path.join(migrationsDir, `${first}.sql`), sql);
    const proceeded = runNode(root, 'scripts/run-framework.mjs', 'build');
    assert.doesNotMatch(proceeded.stderr, /Migration check failed/);
    assert.match(proceeded.stderr, /node_modules[\\/]vinext[\\/]dist[\\/]cli\.js/);
  });

  test('the migration CLI checks offline and its local commands take no remote arguments', t => {
    const check = runNode(projectRoot, 'scripts/db-migrations.mjs', 'check');
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, new RegExp(`^Migrations OK: ${migrations.length} in journal order and locked`));
    for (const args of [['apply-local', '--remote'], ['list-local', '--preview'], ['apply-remote'], []]) {
      const refused = runNode(projectRoot, 'scripts/db-migrations.mjs', ...args);
      assert.equal(refused.status, 64, args.join(' '));
      assert.match(refused.stderr, /Extra arguments such as --remote are rejected/);
    }
    const unbuilt = runNode(projectCopy(t), 'scripts/db-migrations.mjs', 'apply-local');
    assert.equal(unbuilt.status, 1, unbuilt.stderr);
    assert.match(unbuilt.stderr, /dist\/server\/wrangler\.json is missing\. Run `npm run build` first/);
  });
});
