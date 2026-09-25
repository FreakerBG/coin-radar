// Applies drizzle/*.sql to a Turso (libSQL) database, in the journal order recorded in
// drizzle/meta/_journal.json - the same migrations the Cloudflare/Sites path applies to D1, and the
// same files db/migrations.lock.json treats as immutable once merged. Turso is a second, independent
// production database (Vercel path): nothing here reads, writes or reaches D1 or Sites, and no
// automated migration of existing D1 data happens here or anywhere - a fresh Turso database starts
// empty (see docs/deployment-runbook.md).
//
// Applied migrations are tracked in a `_turso_migrations` table (deliberately not `d1_migrations`,
// which names Wrangler's own local-D1 tracking table and would be misleading against libSQL). Each
// migration runs inside its own write transaction: a failure names the migration, rolls back only its
// own statements, and leaves earlier migrations applied and recorded - mirroring
// tests/helpers/migration-db.mjs's applyMigrations() for node:sqlite, adapted to libSQL's async client.
//
// Usage: TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... npm run db:migrate:turso
// This is the command that applies migrations to a real production database, so it enforces
// db/migrations.lock.json via verifyMigrations() - an already-applied migration that was later
// rewritten is refused here exactly as it is by the builds. No Turso database has been provisioned for
// this project yet, so it has never been run against a real one; it is proven correct in
// tests/migrate-turso.test.mjs and tests/migrate-turso-safety.test.mjs against @libsql/client's local
// ":memory:" and file: modes, which need no network or credentials.
import { fileURLToPath } from "node:url";
import { readMigrations, verifyMigrations } from "./migrations.mjs";

export const TRACKING_TABLE = "_turso_migrations";

// Applies every migration in `migrations` not yet recorded in TRACKING_TABLE, in order. Returns the
// tags of migrations newly applied (empty if the database was already up to date). `client` is any
// @libsql/client Client - a real Turso connection or a local ":memory:"/file: one in tests.
export async function applyTursoMigrations(client, migrations = readMigrations()) {
  await client.execute(
    `CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  );
  const applied = new Set((await client.execute(`SELECT name FROM ${TRACKING_TABLE} ORDER BY id`)).rows.map(row => row[0]));

  const newlyApplied = [];
  for (const migration of migrations) {
    const name = `${migration.tag}.sql`;
    if (applied.has(name)) continue;

    const tx = await client.transaction("write");
    try {
      for (const statement of migration.statements) await tx.execute(statement);
      await tx.execute({ sql: `INSERT INTO ${TRACKING_TABLE} (name) VALUES (?)`, args: [name] });
      await tx.commit();
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw new Error(`Migration ${name} failed: ${error.message}`, { cause: error });
    }
    newlyApplied.push(migration.tag);
  }
  return newlyApplied;
}

export async function appliedTursoMigrations(client) {
  const exists = await client.execute(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    [TRACKING_TABLE],
  );
  if (!exists.rows.length) return [];
  return (await client.execute(`SELECT name FROM ${TRACKING_TABLE} ORDER BY id`)).rows.map(row => row[0]);
}

async function main() {
  const { createClient } = await import("@libsql/client");
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) {
    console.error("Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN before running scripts/migrate-turso.mjs. No real Turso database is configured for this project yet.");
    process.exit(64);
  }

  // verifyMigrations(), not readMigrations(): this command applies migrations to a real production
  // database, so it must enforce db/migrations.lock.json exactly as the build does
  // (scripts/run-framework.mjs, scripts/build-vercel.mjs). readMigrations() alone only proves the
  // journal is internally consistent; it would happily apply a locked migration whose SQL was edited
  // after it had already been applied elsewhere.
  const migrations = verifyMigrations();
  const client = createClient({ url, authToken });
  try {
    const applied = await applyTursoMigrations(client, migrations);
    if (applied.length) console.log(`Applied ${applied.length} migration(s) to Turso: ${applied.join(", ")}.`);
    else console.log(`Turso database already up to date (${migrations.length} migration(s)).`);
  } finally {
    client.close();
  }
}

// Only run the CLI body when this file is executed directly, so tests can import
// applyTursoMigrations()/appliedTursoMigrations() without TURSO_DATABASE_URL/TURSO_AUTH_TOKEN set.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
