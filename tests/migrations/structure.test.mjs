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
// Synthetic migrations take the next free number after the committed history, so these tests keep
// passing as real migrations are appended. `next` is that journal position.
const number = position => String(position).padStart(4, '0');
const next = migrations.length;
const probe = `${number(next)}_probe`;

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
    duplicate.append(probe);
    duplicate.editJournal(entries => { entries[next].idx = next - 1; });
    assertRejected(duplicate, `journal entry ${next} (${probe}): idx is ${next - 1}, expected ${next}`);

    const gap = historyCopy(t);
    gap.append(probe);
    gap.editJournal(entries => { entries[next].idx = next + 1; });
    assertRejected(gap, `journal entry ${next} (${probe}): idx is ${next + 1}, expected ${next}`);

    const misnumbered = historyCopy(t);
    misnumbered.append(`${number(next + 1)}_probe`);
    assertRejected(misnumbered, `journal entry ${next} (${number(next + 1)}_probe): tag is numbered ${number(next + 1)}, expected ${number(next)}`);
  });

  test('duplicate migration numbers, unlisted SQL files and missing SQL files', t => {
    const duplicate = historyCopy(t);
    writeFileSync(duplicate.file('0000_duplicate_probe.sql'), 'CREATE TABLE harness_probe (id text)');
    assertRejected(duplicate, `duplicate migration number 0000: 0000_duplicate_probe.sql, ${first}.sql`);
    assertRejected(duplicate, /0000_duplicate_probe\.sql is not listed in meta\/_journal\.json/);

    const missing = historyCopy(t);
    missing.append(probe);
    rmSync(missing.file(`${probe}.sql`));
    assertRejected(missing, `drizzle/${probe}.sql is missing`);
  });

  test('a journal timestamp that is not newer, and disabled statement breakpoints', t => {
    const stale = historyCopy(t);
    stale.append(probe);
    stale.editJournal(entries => { entries[next].when = entries[next - 1].when; });
    assertRejected(stale, `journal entry ${next} (${probe}): "when" must be an integer timestamp newer than the previous entry's`);

    const combined = historyCopy(t);
    combined.editJournal(entries => { entries[0].breakpoints = false; });
    assertRejected(combined, `journal entry 0 (${first}): "breakpoints" must be true`);
  });

  test('empty statements, a broken snapshot chain and an unreadable journal', t => {
    const empty = historyCopy(t);
    empty.append(probe, 'CREATE TABLE harness_probe (id text);\n--> statement-breakpoint\n-- nothing here\n');
    assertRejected(empty, `${probe}.sql: statement 2 is empty`);

    const chain = historyCopy(t);
    chain.append(probe);
    const snapshot = chain.file(`meta/${number(next)}_snapshot.json`);
    writeFileSync(snapshot, JSON.stringify({...JSON.parse(readFileSync(snapshot, 'utf8')), prevId: 'unrelated'}));
    assertRejected(chain, `${probe}: snapshot prevId does not point at the previous migration's snapshot`);
    rmSync(snapshot);
    assertRejected(chain, `meta/${number(next)}_snapshot.json is missing`);

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
    removed.append(probe);
    removed.lockAll();
    assert.equal(removed.verify().length, migrations.length + 1);
    removed.editJournal(entries => { entries.pop(); });
    rmSync(removed.file(`${probe}.sql`));
    rmSync(removed.file(`meta/${number(next)}_snapshot.json`));
    assertRejected(removed, `${probe} is locked but no longer listed in the journal`);
  });

  test('a new migration is refused until its entry is appended to the lock', t => {
    const copy = historyCopy(t);
    copy.append(probe);
    const entry = lockEntry(copy.read().at(-1));
    assertRejected(copy, `append ${JSON.stringify(entry)}`);
    const lock = JSON.parse(readFileSync(copy.lockFile, 'utf8'));
    writeFileSync(copy.lockFile, JSON.stringify({...lock, migrations: [...lock.migrations, entry]}, null, 2));
    assert.deepEqual(copy.verify().map(migration => migration.tag), [...migrations.map(migration => migration.tag), probe]);
  });
});

// A minimal copy of the project, at a path containing a space: enough for the build gate and
// migration CLI, without dependencies.
function projectCopy(t) {
  const root = temporaryDirectory(t, 'coin-radar project-');
  for (const file of ['scripts/run-framework.mjs', 'scripts/execution-profile.mjs', 'scripts/migrations.mjs', 'scripts/db-migrations.mjs', 'scripts/sites-env.mjs', 'db/migrations.lock.json', '.openai/hosting.json']) {
    mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
    cpSync(path.join(projectRoot, file), path.join(root, file));
  }
  cpSync(migrationsDir, path.join(root, 'drizzle'), {recursive: true});
  return root;
}
// Stands in for a dependency's CLI in a project copy: prints the arguments it received and exits
// with STUB_EXIT_CODE, so a test sees exactly what the wrapper passed on and returned.
function stubCli(root, file) {
  mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
  writeFileSync(path.join(root, file), 'console.log(JSON.stringify(process.argv.slice(2)));\nprocess.exitCode = Number(process.env.STUB_EXIT_CODE ?? 0);\n');
}
const runNode = (cwd, args, env = {}) => spawnSync(process.execPath, args, {cwd, encoding: 'utf8', env: {...process.env, ...env}});
const stubArguments = result => JSON.parse(result.stdout.trim().split('\n').at(-1));

describe('enforcement outside the test suite', () => {
  test('npm run build refuses a rewritten migration before building anything', t => {
    const root = projectCopy(t);
    stubCli(root, 'node_modules/vinext/dist/cli.js');
    const sql = path.join(root, 'drizzle', `${first}.sql`);
    writeFileSync(sql, `${readFileSync(sql, 'utf8')}\n-- edited after publishing\n`);
    const refused = runNode(root, ['scripts/run-framework.mjs', 'build']);
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, new RegExp(`Migration check failed:[\\s\\S]*${first}\\.sql changed after it was locked`));
    assert.equal(refused.stdout, '', 'the framework build never started');
    assert.equal(existsSync(path.join(root, 'dist')), false);

    // Restored, the check passes and the framework build receives every argument unchanged and
    // decides the exit code.
    cpSync(path.join(migrationsDir, `${first}.sql`), sql);
    const proceeded = runNode(root, ['scripts/run-framework.mjs', 'build', '--mode', 'production', 'two words'], {STUB_EXIT_CODE: '7'});
    assert.equal(proceeded.status, 7, proceeded.stderr);
    assert.deepEqual(stubArguments(proceeded), ['build', '--mode', 'production', 'two words']);
  });

  test('the migration CLI checks offline and its local commands take no remote arguments', t => {
    const check = runNode(projectRoot, ['scripts/db-migrations.mjs', 'check']);
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, new RegExp(`^Migrations OK: ${migrations.length} in journal order and locked`));
    for (const args of [['apply-local', '--remote'], ['list-local', '--preview'], ['apply-remote'], []]) {
      const refused = runNode(projectRoot, ['scripts/db-migrations.mjs', ...args]);
      assert.equal(refused.status, 64, args.join(' '));
      assert.match(refused.stderr, /Extra arguments such as --remote are rejected/);
    }
    const unbuilt = runNode(projectCopy(t), ['scripts/db-migrations.mjs', 'apply-local']);
    assert.equal(unbuilt.status, 1, unbuilt.stderr);
    assert.match(unbuilt.stderr, /dist\/server\/wrangler\.json is missing\. Run `npm run build` first/);
  });

  test('the local migration commands always call Wrangler with --local, the built binding and drizzle/', t => {
    const root = projectCopy(t);
    stubCli(root, 'node_modules/wrangler/bin/wrangler.js');
    mkdirSync(path.join(root, 'dist', 'server'), {recursive: true});
    writeFileSync(path.join(root, 'dist', 'server', 'wrangler.json'), JSON.stringify({
      name: 'coin-radar', compatibility_date: '2026-01-01',
      d1_databases: [{binding: 'DB', database_name: 'site-creator-d1', database_id: '00000000-0000-4000-8000-000000000000'}],
    }));
    const configFile = path.join(root, '.wrangler', 'local-migrations', 'wrangler.json');
    for (const [command, wranglerCommand] of [['apply-local', 'apply'], ['list-local', 'list']]) {
      const result = runNode(root, ['scripts/db-migrations.mjs', command], {STUB_EXIT_CODE: '3'});
      assert.equal(result.status, 3, result.stderr);
      assert.deepEqual(stubArguments(result),
        ['d1', 'migrations', wranglerCommand, 'DB', '--local', '--persist-to', '.wrangler/state', '--config', configFile]);
    }
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.deepEqual(config.d1_databases.map(database => [database.binding, database.database_name]), [['DB', 'site-creator-d1']]);
    assert.equal(path.resolve(path.dirname(configFile), config.d1_databases[0].migrations_dir), path.join(root, 'drizzle'));
  });
});
