// Offline checks for the Drizzle migrations that Sites publishing applies to production D1.
// `npm run build` runs them before anything is packaged; the local D1 commands and the
// migration tests reuse them. Files only: no database, no Wrangler, no network.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = fileURLToPath(new URL("../", import.meta.url));
export const migrationsDir = path.join(projectRoot, "drizzle");
export const migrationLockFile = path.join(projectRoot, "db", "migrations.lock.json");

const TAG = /^(\d{4})_[a-z0-9_]+$/;
const FIRST_SNAPSHOT_PREV_ID = "00000000-0000-0000-0000-000000000000";

export class MigrationCheckError extends Error {
  constructor(problems) {
    super(`Migration check failed:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "MigrationCheckError";
    this.problems = problems;
  }
}

// Windows checkouts may use CRLF; hash the committed LF form so every platform agrees.
const normalizeLineEndings = (text) => text.replace(/\r\n/g, "\n");
export const sha256 = (text) => createHash("sha256").update(normalizeLineEndings(text)).digest("hex");

function label(file) {
  const relative = path.relative(projectRoot, file);
  return (relative.startsWith("..") || path.isAbsolute(relative) ? file : relative).split(path.sep).join("/");
}

function readJson(file, problems) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    problems.push(`cannot read ${label(file)}: ${error.message}`);
    return null;
  }
}

// Drizzle and Sites split each file on this marker and run the parts as separate statements.
export function splitStatements(sql) {
  return normalizeLineEndings(sql).split("--> statement-breakpoint").map((part) => part.trim());
}

const isEmptyStatement = (statement) => !statement.replace(/--[^\n]*/g, "").trim();

// Reads drizzle/meta/_journal.json and every file it lists. Throws MigrationCheckError listing
// every problem, so a malformed history can never be partially trusted.
export function readMigrations({ dir = migrationsDir } = {}) {
  const problems = [];
  const journalFile = path.join(dir, "meta", "_journal.json");
  const journal = readJson(journalFile, problems);
  if (!journal) throw new MigrationCheckError(problems);
  if (journal.dialect !== "sqlite") problems.push(`${label(journalFile)}: dialect must be "sqlite"`);
  const entries = Array.isArray(journal.entries) ? journal.entries : [];
  if (!entries.length) problems.push(`${label(journalFile)}: no migrations are listed`);

  const migrations = [];
  const tags = new Set();
  let previousWhen = null;
  entries.forEach((entry, position) => {
    const number = String(position).padStart(4, "0");
    const name = `journal entry ${position} (${entry?.tag})`;
    if (entry?.idx !== position) {
      problems.push(`${name}: idx is ${entry?.idx}, expected ${position}; entries must be numbered 0, 1, 2... without gaps or duplicates`);
    }
    const match = TAG.exec(entry?.tag ?? "");
    if (!match) problems.push(`${name}: tag must look like ${number}_name`);
    else if (match[1] !== number) problems.push(`${name}: tag is numbered ${match[1]}, expected ${number}`);
    if (tags.has(entry?.tag)) problems.push(`${name}: duplicate migration tag`);
    tags.add(entry?.tag);
    if (!Number.isSafeInteger(entry?.when) || (previousWhen !== null && entry.when <= previousWhen)) {
      problems.push(`${name}: "when" must be an integer timestamp newer than the previous entry's; Drizzle-style tracking silently skips a migration that is not newer than the last applied one`);
    }
    if (Number.isSafeInteger(entry?.when)) previousWhen = Math.max(previousWhen ?? entry.when, entry.when);
    if (entry?.breakpoints !== true) problems.push(`${name}: "breakpoints" must be true so each statement runs separately on D1`);

    const file = path.join(dir, `${entry?.tag}.sql`);
    let sql = null;
    let statements = [];
    if (!existsSync(file)) {
      problems.push(`${name}: ${label(file)} is missing`);
    } else {
      sql = readFileSync(file, "utf8");
      statements = splitStatements(sql);
      statements.forEach((statement, index) => {
        if (isEmptyStatement(statement)) problems.push(`${label(file)}: statement ${index + 1} is empty`);
      });
    }

    const snapshotFile = path.join(dir, "meta", `${number}_snapshot.json`);
    let snapshotText = null;
    let snapshot = null;
    if (!existsSync(snapshotFile)) {
      problems.push(`${name}: ${label(snapshotFile)} is missing; generate migrations with npm run db:generate`);
    } else {
      snapshotText = readFileSync(snapshotFile, "utf8");
      snapshot = readJson(snapshotFile, problems);
    }

    migrations.push({
      idx: position,
      tag: entry?.tag,
      when: entry?.when,
      file,
      statements,
      sqlSha256: sql === null ? null : sha256(sql),
      snapshotSha256: snapshotText === null ? null : sha256(snapshotText),
      snapshotId: snapshot?.id,
      snapshotPrevId: snapshot?.prevId,
    });
  });

  // Wrangler-style tracking applies every top-level .sql file; Drizzle-style tracking applies
  // only journal entries. Any difference means the two would build different databases.
  const listed = new Set(entries.map((entry) => `${entry?.tag}.sql`));
  const byNumber = new Map();
  for (const fileName of existsSync(dir) ? readdirSync(dir) : []) {
    if (!fileName.endsWith(".sql")) continue;
    if (!listed.has(fileName)) problems.push(`${label(path.join(dir, fileName))} is not listed in meta/_journal.json`);
    const prefix = fileName.split("_")[0];
    byNumber.set(prefix, [...(byNumber.get(prefix) ?? []), fileName]);
  }
  for (const [prefix, fileNames] of byNumber) {
    if (fileNames.length > 1) problems.push(`duplicate migration number ${prefix}: ${fileNames.sort().join(", ")}`);
  }

  const snapshotIds = new Set();
  migrations.forEach((migration, position) => {
    if (migration.snapshotSha256 === null) return;
    const expectedPrevId = position === 0 ? FIRST_SNAPSHOT_PREV_ID : migrations[position - 1].snapshotId;
    if (!migration.snapshotId || snapshotIds.has(migration.snapshotId)) {
      problems.push(`${migration.tag}: snapshot id is missing or duplicated`);
    }
    snapshotIds.add(migration.snapshotId);
    if (migration.snapshotPrevId !== expectedPrevId) {
      problems.push(`${migration.tag}: snapshot prevId does not point at the previous migration's snapshot`);
    }
  });

  if (problems.length) throw new MigrationCheckError(problems);
  return migrations;
}

export const lockEntry = (migration) => ({
  tag: migration.tag,
  when: migration.when,
  sql: migration.sqlSha256,
  snapshot: migration.snapshotSha256,
});

// db/migrations.lock.json records every migration that may have reached production D1.
// Locked entries must never change; new migrations are appended in the same change.
export function checkLock(migrations, lockFile = migrationLockFile) {
  const problems = [];
  const lock = readJson(lockFile, problems);
  if (!lock) return problems;
  if (!Array.isArray(lock.migrations)) return [`${label(lockFile)}: "migrations" must be an array`];

  lock.migrations.forEach((locked, position) => {
    const migration = migrations[position];
    if (!migration) {
      problems.push(`${locked?.tag} is locked but no longer listed in the journal; applied migrations must never be removed`);
    } else if (migration.tag !== locked?.tag) {
      problems.push(`journal position ${position} is ${migration.tag} but the lock records ${locked?.tag}; applied migrations must never be renamed, reordered or renumbered`);
    } else {
      const rewrite = "Applied migrations are immutable: restore the committed version and add a new migration instead (docs/deployment-runbook.md)";
      if (migration.when !== locked.when) problems.push(`${migration.tag}: journal "when" changed after it was locked. ${rewrite}`);
      if (migration.sqlSha256 !== locked.sql) problems.push(`${migration.tag}.sql changed after it was locked. ${rewrite}`);
      if (migration.snapshotSha256 !== locked.snapshot) problems.push(`${migration.tag}: meta snapshot changed after it was locked. ${rewrite}`);
    }
  });
  for (const migration of migrations.slice(lock.migrations.length)) {
    problems.push(`${migration.tag} is not in ${label(lockFile)}. After reviewing it (docs/deployment-runbook.md), append ${JSON.stringify(lockEntry(migration))}`);
  }
  return problems;
}

export function verifyMigrations({ dir = migrationsDir, lockFile = migrationLockFile } = {}) {
  const migrations = readMigrations({ dir });
  const problems = checkLock(migrations, lockFile);
  if (problems.length) throw new MigrationCheckError(problems);
  return migrations;
}
