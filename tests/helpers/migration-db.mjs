// Real-migration database helpers: apply drizzle/ to node:sqlite, create isolated temporary
// database files, and describe schema and data for the compatibility and upgrade checks.
// Offline only; nothing here opens a Wrangler, Miniflare or remote D1 database.
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {isDeepStrictEqual} from 'node:util';
import {readMigrations} from '../../scripts/migrations.mjs';

// Same table and file-name records as `wrangler d1 migrations apply` (npm run db:migrate:local).
export const TRACKING_TABLE = 'd1_migrations';
const quote = name => `"${name.replaceAll('"', '""')}"`;

export function appliedMigrations(sqlite) {
  const tracked = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(TRACKING_TABLE);
  return tracked ? sqlite.prepare(`SELECT name FROM ${TRACKING_TABLE} ORDER BY id`).all().map(row => row.name) : [];
}

// Applies and records each pending migration individually, as Sites publishing documents, each in
// its own transaction: a failure names the migration, keeps earlier ones and records nothing for it.
export function applyMigrations(sqlite, migrations = readMigrations()) {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`);
  const applied = new Set(appliedMigrations(sqlite));
  const newlyApplied = [];
  for (const migration of migrations) {
    const name = `${migration.tag}.sql`;
    if (applied.has(name)) continue;
    sqlite.exec('BEGIN');
    try {
      for (const statement of migration.statements) sqlite.exec(statement);
      sqlite.prepare(`INSERT INTO ${TRACKING_TABLE} (name) VALUES (?)`).run(name);
      sqlite.exec('COMMIT');
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw new Error(`Migration ${name} failed: ${error.message}`, {cause: error});
    }
    newlyApplied.push(migration.tag);
  }
  return newlyApplied;
}

// A database file in its own uniquely named directory. cleanup() closes the handle first so the
// directory can be removed on Windows too; parallel runs never share a file.
export function createTempDatabase() {
  const directory = mkdtempSync(path.join(tmpdir(), 'coin-radar-d1-'));
  const file = path.join(directory, 'd1.sqlite');
  let sqlite = new DatabaseSync(file);
  let open = true;
  return {
    directory,
    file,
    get sqlite() { return sqlite; },
    // A new connection to the same file, as a new deployment would open it.
    reopen() {
      if (open) sqlite.close();
      sqlite = new DatabaseSync(file);
      open = true;
      return sqlite;
    },
    cleanup() {
      if (open) sqlite.close();
      open = false;
      rmSync(directory, {recursive: true, force: true, maxRetries: 5, retryDelay: 50});
    },
  };
}

// Application tables: everything except SQLite, D1 and migration-tracking internals.
export function applicationTables(sqlite) {
  return sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
    .map(row => row.name)
    .filter(name => !name.startsWith('sqlite_') && !name.startsWith('_cf_') && name !== TRACKING_TABLE);
}

export function columns(sqlite, table) {
  return sqlite.prepare(`PRAGMA table_info(${quote(table)})`).all().map(column => ({
    name: column.name, type: column.type, notNull: column.notnull === 1, defaultValue: column.dflt_value, primaryKeyPosition: column.pk,
  }));
}

export function primaryKey(sqlite, table) {
  return columns(sqlite, table).filter(column => column.primaryKeyPosition > 0)
    .sort((a, b) => a.primaryKeyPosition - b.primaryKeyPosition).map(column => column.name);
}

// Column lists that SQLite enforces as unique: the primary key and full (non-partial) unique indexes.
export function uniqueKeys(sqlite, table) {
  const keys = sqlite.prepare(`PRAGMA index_list(${quote(table)})`).all()
    .filter(index => index.unique === 1 && index.partial === 0)
    .map(index => sqlite.prepare(`PRAGMA index_info(${quote(index.name)})`).all().sort((a, b) => a.seqno - b.seqno).map(column => column.name));
  const key = primaryKey(sqlite, table);
  if (key.length) keys.push(key);
  return keys;
}

export function snapshotData(sqlite) {
  return Object.fromEntries(applicationTables(sqlite).map(table => [table, {
    columns: columns(sqlite, table).map(column => column.name),
    key: primaryKey(sqlite, table),
    rows: sqlite.prepare(`SELECT * FROM ${quote(table)}`).all().map(row => ({...row})),
  }]));
}

// Every table, column and row captured before an upgrade must still exist afterwards with the same
// values. New tables, columns and rows are allowed. `allowed` lists "table" or "table.column"
// entries that a migration's upgrade fixture explicitly declares it changes.
export function dataChanges(before, after, allowed = []) {
  const problems = [];
  const isAllowed = (table, column) => allowed.includes(table) || (column !== undefined && allowed.includes(`${table}.${column}`));
  for (const [table, previous] of Object.entries(before)) {
    if (isAllowed(table)) continue;
    const current = after[table];
    if (!current) {
      problems.push(`table ${table} was removed (${previous.rows.length} row(s))`);
      continue;
    }
    const kept = previous.columns.filter(column => current.columns.includes(column));
    for (const column of previous.columns) {
      if (!kept.includes(column) && !isAllowed(table, column)) problems.push(`column ${table}.${column} was removed`);
    }
    const key = previous.key.length ? previous.key : previous.columns;
    if (!key.every(column => current.columns.includes(column))) continue;
    const identify = row => JSON.stringify(key.map(column => row[column]));
    const remaining = new Map();
    for (const row of current.rows) remaining.set(identify(row), [...(remaining.get(identify(row)) ?? []), row]);
    for (const row of previous.rows) {
      const next = remaining.get(identify(row))?.shift();
      if (!next) {
        problems.push(`${table} row ${identify(row)} was deleted`);
        continue;
      }
      for (const column of kept) {
        if (!isAllowed(table, column) && !isDeepStrictEqual(next[column], row[column])) {
          problems.push(`${table} row ${identify(row)}: ${column} changed from ${JSON.stringify(row[column])} to ${JSON.stringify(next[column])}`);
        }
      }
    }
  }
  return problems;
}
