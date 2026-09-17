// Upgrade path: a database file built from the historical migrations and filled with representative
// rows is reopened, as a new deployment would open it, and upgraded to the current migrations.
// Existing rows must survive unchanged and stay usable through the real routes.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {readMigrations, splitStatements} from '../../scripts/migrations.mjs';
import {startClock} from '../helpers/harness.mjs';
import {appliedMigrations, applyMigrations, createTempDatabase, dataChanges, snapshotData} from '../helpers/migration-db.mjs';
import {applicationStatements, schemaContractProblems, statementProblems} from './schema-contract.mjs';
import {upgradeFixtures} from './upgrade-fixtures.mjs';

const migrations = readMigrations();
const tags = migrations.map(migration => migration.tag);

// Builds a database file at `history`, seeding each migration's fixture right after it is applied.
function buildHistoricalDatabase(t, history) {
  startClock();
  const database = createTempDatabase();
  t.after(() => database.cleanup());
  for (const migration of history) {
    assert.deepEqual(applyMigrations(database.sqlite, [migration]), [migration.tag]);
    upgradeFixtures[migration.tag].seed(database.sqlite);
  }
  return database.reopen();
}

test('every migration has an upgrade fixture, in journal order', () => {
  assert.deepEqual(Object.keys(upgradeFixtures), tags,
    'add a seed/verify entry to tests/migrations/upgrade-fixtures.mjs in the same change as each new migration');
});

describe('upgrading a populated database to the current migrations', () => {
  for (let appliedCount = 1; appliedCount <= migrations.length; appliedCount++) {
    const history = migrations.slice(0, appliedCount);
    const pending = migrations.slice(appliedCount);
    const name = pending.length
      ? `from ${history.at(-1).tag} through ${pending.at(-1).tag}`
      : `redeploying onto ${history.at(-1).tag} applies nothing and keeps every row`;
    test(name, async t => {
      const sqlite = buildHistoricalDatabase(t, history);
      assert.deepEqual(appliedMigrations(sqlite), history.map(migration => `${migration.tag}.sql`));
      const before = snapshotData(sqlite);
      assert.ok(Object.values(before).every(table => table.rows.length > 0), 'every table holds representative rows before the upgrade');

      assert.deepEqual(applyMigrations(sqlite, migrations), pending.map(migration => migration.tag));
      assert.deepEqual(applyMigrations(sqlite, migrations), [], 'a later deployment applies nothing again');
      const declared = pending.flatMap(migration => Object.keys(upgradeFixtures[migration.tag].changes ?? {}));
      assert.deepEqual(dataChanges(before, snapshotData(sqlite), declared), []);
      assert.deepEqual(schemaContractProblems(sqlite), []);
      assert.deepEqual(statementProblems(sqlite), []);
      for (const migration of history) await upgradeFixtures[migration.tag].verify(sqlite);
    });
  }
});

// Harness self-tests: synthetic migrations exist only in memory here, never in drizzle/.
describe('the upgrade checks reject unsafe migrations', () => {
  const synthetic = (tag, sql) => ({tag, statements: splitStatements(sql)});
  function upgradeWith(t, migration) {
    const sqlite = buildHistoricalDatabase(t, migrations);
    const before = snapshotData(sqlite);
    assert.deepEqual(applyMigrations(sqlite, [...migrations, migration]), [migration.tag]);
    return {sqlite, before, after: snapshotData(sqlite)};
  }

  test('an additive migration keeps every row and application read intact', async t => {
    const {sqlite, before, after} = upgradeWith(t, synthetic('9001_additive_probe', 'ALTER TABLE research_positions ADD COLUMN note text'));
    assert.deepEqual(dataChanges(before, after), []);
    assert.deepEqual(schemaContractProblems(sqlite), []);
    for (const tag of tags) await upgradeFixtures[tag].verify(sqlite);
  });

  test('removed tables, columns and rows and rewritten values are reported unless declared', t => {
    const {before, after} = upgradeWith(t, synthetic('9002_destructive_probe', [
      'DROP TABLE research_locks',
      'ALTER TABLE research_events DROP COLUMN kind',
      "DELETE FROM social_cache WHERE address LIKE 'TokenB%'",
      "UPDATE research_accounts SET config = '{}' WHERE user_id = 'user-b'",
    ].join(';\n--> statement-breakpoint\n')));
    const problems = dataChanges(before, after);
    assert.equal(problems.length, 4, problems.join('\n'));
    assert.match(problems.join('\n'), /table research_locks was removed \(1 row\(s\)\)/);
    assert.match(problems.join('\n'), /column research_events\.kind was removed/);
    assert.match(problems.join('\n'), /social_cache row \["TokenB\w+"\] was deleted/);
    assert.match(problems.join('\n'), /research_accounts row \["user-b"\]: config changed from "\{\\"bankroll\\":250,\\"riskPct\\":2\}" to "\{\}"/);
    assert.deepEqual(dataChanges(before, after, ['research_locks', 'research_events.kind', 'social_cache', 'research_accounts.config']), []);
  });

  test('a schema change that breaks the application is reported before any route runs', async t => {
    const {sqlite, before, after} = upgradeWith(t, synthetic('9003_rename_probe', 'ALTER TABLE research_positions RENAME COLUMN data TO payload'));
    assert.deepEqual(dataChanges(before, after), ['column research_positions.data was removed']);
    assert.ok(schemaContractProblems(sqlite).includes('missing column research_positions.data'));
    const broken = statementProblems(sqlite, applicationStatements().statements);
    assert.ok(broken.some(problem => problem.startsWith('lib/research-db.ts: no such column: data')), broken.join('\n'));
    await assert.rejects(upgradeFixtures[tags[0]].verify(sqlite), assert.AssertionError);
  });
});
