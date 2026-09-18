// Checks the application's schema requirements (lib/schema-requirements.ts) against a migrated database.
// Constraints are checked by meaning (affinity, nullability, unique keys, application-style inserts),
// not by SQL text, so harmless formatting or column-order changes in new migrations do not fail.
import {readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {requiredTables, schemaProbes} from '../../lib/schema-requirements.ts';
import {projectRoot} from '../../scripts/migrations.mjs';
import {applicationTables, columns, primaryKey, uniqueKeys} from '../helpers/migration-db.mjs';

export {requiredTables};

const PROBE = 'schema-contract-probe';

// SQLite's type-affinity rules (https://www.sqlite.org/datatype3.html#determination_of_column_affinity).
export function affinity(declaredType) {
  const type = declaredType.toUpperCase();
  if (type.includes('INT')) return 'INTEGER';
  if (/CHAR|CLOB|TEXT/.test(type)) return 'TEXT';
  if (!type || type.includes('BLOB')) return 'BLOB';
  if (/REAL|FLOA|DOUB/.test(type)) return 'REAL';
  return 'NUMERIC';
}

const sameColumns = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

// Inserts a row the way the application does inside a savepoint that is always rolled back.
function insertProblems(sqlite, table, spec) {
  const problems = [];
  const values = Object.fromEntries(spec.inserted.map(name => [name, spec.columns[name] === 'INTEGER' ? 1 : spec.columns[name] === 'REAL' ? 1.5 : `${PROBE}:${name}`]));
  sqlite.exec('SAVEPOINT schema_contract');
  try {
    sqlite.prepare(`INSERT INTO ${table} (${spec.inserted.join(', ')}) VALUES (${spec.inserted.map(() => '?').join(', ')})`).run(...Object.values(values));
    const defaults = Object.entries(spec.defaults ?? {});
    if (defaults.length) {
      const row = sqlite.prepare(`SELECT ${defaults.map(([name]) => name).join(', ')} FROM ${table} WHERE ${spec.key.map(name => `${name} = ?`).join(' AND ')}`)
        .get(...spec.key.map(name => values[name]));
      for (const [name, expected] of defaults) {
        if (row[name] !== expected) problems.push(`${table}.${name} must default to ${JSON.stringify(expected)}, found ${JSON.stringify(row[name])}`);
      }
    }
  } catch (error) {
    problems.push(`${table}: the application's insert of (${spec.inserted.join(', ')}) fails: ${error.message}`);
  } finally {
    sqlite.exec('ROLLBACK TO schema_contract');
    sqlite.exec('RELEASE schema_contract');
  }
  return problems;
}

export function schemaContractProblems(sqlite) {
  const problems = [];
  const tables = new Set(applicationTables(sqlite));
  for (const [table, spec] of Object.entries(requiredTables)) {
    if (!tables.has(table)) {
      problems.push(`missing table ${table}`);
      continue;
    }
    const actual = new Map(columns(sqlite, table).map(column => [column.name, column]));
    const missing = Object.keys(spec.columns).filter(name => !actual.has(name));
    for (const name of missing) problems.push(`missing column ${table}.${name}`);
    for (const [name, expected] of Object.entries(spec.columns)) {
      const column = actual.get(name);
      if (!column) continue;
      if (affinity(column.type) !== expected) problems.push(`${table}.${name} has ${affinity(column.type)} affinity, expected ${expected}`);
      const nullable = spec.nullable?.includes(name) ?? false;
      if (column.notNull === nullable) problems.push(`${table}.${name} must be ${nullable ? 'nullable' : 'NOT NULL'}`);
    }
    if (!uniqueKeys(sqlite, table).some(key => sameColumns(key, spec.key))) {
      problems.push(`${table} needs a PRIMARY KEY or UNIQUE constraint on exactly (${spec.key.join(', ')})`);
    }
    if (spec.shared) {
      for (const name of actual.keys()) {
        if (!Object.hasOwn(spec.columns, name)) problems.push(`${table} is shared by every user; new column ${name} needs a cross-user isolation review`);
      }
    }
    if (!missing.length) problems.push(...insertProblems(sqlite, table, spec));
  }
  return problems;
}

function sourceFiles(directory) {
  return readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.(ts|tsx|mjs|js)$/.test(entry.name) ? [file] : [];
  });
}

// prepare() calls whose SQL is generated at runtime, with every statement they can issue.
const generatedStatements = {
  'app/api/health/route.ts': {calls: 1, statements: () => schemaProbes().map(probe => probe.sql)},
};

// Every D1 statement the application prepares. A prepare() whose SQL is neither a plain string literal
// nor registered in generatedStatements, and any exec() call, is reported so this check is extended
// rather than skipping it.
export function applicationStatements() {
  const statements = [];
  const unchecked = [];
  for (const file of ['app', 'lib', 'db'].flatMap(root => sourceFiles(path.join(projectRoot, root)))) {
    const source = readFileSync(file, 'utf8');
    const name = path.relative(projectRoot, file).split(path.sep).join('/');
    const calls = source.match(/\.prepare\(/g)?.length ?? 0;
    const literals = [...source.matchAll(/\.prepare\(\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1\s*\)/g)]
      .filter(([, quote, sql]) => quote !== '`' || !sql.includes('${'))
      .map(([, , sql]) => sql.replace(/\\(.)/g, '$1'));
    const generated = generatedStatements[name];
    if (calls - literals.length !== (generated?.calls ?? 0)) {
      unchecked.push(`${name}: ${calls - literals.length} prepare() call(s) without a plain SQL string literal`);
    }
    // D1's exec() runs raw SQL that is never prepared here (RegExp exec() is reported too; check it by hand).
    const execs = source.match(/\.exec\(/g)?.length ?? 0;
    if (execs) unchecked.push(`${name}: ${execs} exec() call(s) whose SQL is not checked`);
    statements.push(...literals.map(sql => ({file: name, sql})), ...(generated?.statements() ?? []).map(sql => ({file: name, sql})));
  }
  return {statements, unchecked};
}

// SQLite resolves tables, columns and ON CONFLICT targets when a statement is prepared.
export function statementProblems(sqlite, statements = applicationStatements().statements) {
  return statements.flatMap(({file, sql}) => {
    try {
      sqlite.prepare(sql);
      return [];
    } catch (error) {
      return [`${file}: ${error.message}\n    ${sql}`];
    }
  });
}

const indexSignature = (unique, names) => `${unique ? 'unique' : 'index'}(${[...names].sort().join(', ')})`;
const foreignKeySignature = (names, table, targets) => `(${names.join(', ')}) -> ${table}(${targets.join(', ')})`;

// db/schema.ts is what `npm run db:generate` diffs against; it must describe what the migrations built.
export async function drizzleModelProblems(sqlite) {
  const {getTableName, is} = await import('drizzle-orm');
  const {getTableConfig, SQLiteTable} = await import('drizzle-orm/sqlite-core');
  const model = await import('../../db/schema.ts');
  const problems = [];
  const migrated = new Set(applicationTables(sqlite));
  const tables = Object.values(model).filter(value => is(value, SQLiteTable)).map(table => getTableConfig(table));
  for (const name of migrated) {
    if (!tables.some(table => table.name === name)) problems.push(`table ${name} is created by migrations but missing from db/schema.ts`);
  }
  for (const table of tables) {
    if (!migrated.has(table.name)) {
      problems.push(`db/schema.ts defines table ${table.name} but no migration creates it (run npm run db:generate)`);
      continue;
    }
    const actual = new Map(columns(sqlite, table.name).map(column => [column.name, column]));
    for (const name of actual.keys()) {
      if (!table.columns.some(column => column.name === name)) problems.push(`column ${table.name}.${name} is created by migrations but missing from db/schema.ts`);
    }
    for (const column of table.columns) {
      const migratedColumn = actual.get(column.name);
      const label = `${table.name}.${column.name}`;
      if (!migratedColumn) {
        problems.push(`db/schema.ts defines ${label} but no migration creates it (run npm run db:generate)`);
        continue;
      }
      if (affinity(column.getSQLType()) !== affinity(migratedColumn.type)) problems.push(`${label}: db/schema.ts type ${column.getSQLType()} differs from migrated ${migratedColumn.type}`);
      if (column.notNull !== migratedColumn.notNull) problems.push(`${label}: NOT NULL differs between db/schema.ts and the migrations`);
      if ((column.default !== undefined) !== (migratedColumn.defaultValue !== null)) {
        problems.push(`${label}: SQL default presence differs between db/schema.ts and the migrations`);
      } else if (['number', 'string'].includes(typeof column.default)) {
        const literal = typeof column.default === 'number' ? String(column.default) : `'${column.default.replaceAll("'", "''")}'`;
        if (literal !== migratedColumn.defaultValue) problems.push(`${label}: default ${literal} in db/schema.ts, ${migratedColumn.defaultValue} after migrations`);
      }
    }
    const modelKey = [...table.columns.filter(column => column.primary).map(column => column.name), ...table.primaryKeys.flatMap(key => key.columns.map(column => column.name))];
    if (!sameColumns(modelKey, primaryKey(sqlite, table.name))) problems.push(`${table.name}: primary key differs between db/schema.ts and the migrations`);

    const modelIndexes = [
      ...table.indexes.map(index => indexSignature(index.config.unique, index.config.columns.map(column => column.name))),
      ...table.uniqueConstraints.map(constraint => indexSignature(true, constraint.columns.map(column => column.name))),
      ...table.columns.filter(column => column.isUnique).map(column => indexSignature(true, [column.name])),
    ].sort();
    const migratedIndexes = sqlite.prepare(`PRAGMA index_list("${table.name}")`).all().filter(index => index.origin !== 'pk')
      .map(index => indexSignature(index.unique === 1, sqlite.prepare(`PRAGMA index_info("${index.name}")`).all().map(column => column.name))).sort();
    if (modelIndexes.join() !== migratedIndexes.join()) problems.push(`${table.name}: indexes differ (db/schema.ts [${modelIndexes.join('; ')}], migrations [${migratedIndexes.join('; ')}])`);

    const modelForeignKeys = table.foreignKeys.map(foreignKey => {
      const reference = foreignKey.reference();
      return foreignKeySignature(reference.columns.map(column => column.name), getTableName(reference.foreignTable), reference.foreignColumns.map(column => column.name));
    }).sort();
    const grouped = Map.groupBy(sqlite.prepare(`PRAGMA foreign_key_list("${table.name}")`).all(), row => row.id);
    const migratedForeignKeys = [...grouped.values()].map(rows => foreignKeySignature(rows.map(row => row.from), rows[0].table, rows.map(row => row.to))).sort();
    if (modelForeignKeys.join() !== migratedForeignKeys.join()) problems.push(`${table.name}: foreign keys differ (db/schema.ts [${modelForeignKeys.join('; ')}], migrations [${migratedForeignKeys.join('; ')}])`);
  }
  return problems;
}
