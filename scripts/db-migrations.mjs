// Database migration commands. None of them can reach a remote database:
//   check        offline: validate drizzle/ and db/migrations.lock.json; no database is opened
//   apply-local  apply pending migrations to the local preview D1 in .wrangler/state
//   list-local   list migrations not yet applied to that local preview D1
// Production migrations are applied only by Sites publishing; see docs/deployment-runbook.md.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  checkLock, MigrationCheckError, migrationsDir, projectRoot, readMigrations, verifyMigrations,
} from "./migrations.mjs";

const wranglerCommands = { "apply-local": "apply", "list-local": "list" };
const [command, ...extra] = process.argv.slice(2);
if (extra.length || !(command === "check" || Object.hasOwn(wranglerCommands, command))) {
  console.error("Usage: node scripts/db-migrations.mjs <check|apply-local|list-local>. Extra arguments such as --remote are rejected.");
  process.exit(64);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function orFail(check) {
  try {
    return check();
  } catch (error) {
    if (!(error instanceof MigrationCheckError)) throw error;
    fail(error.message);
  }
}

if (command === "check") {
  const migrations = orFail(() => verifyMigrations());
  console.log(`Migrations OK: ${migrations.length} in journal order and locked (${migrations.map((migration) => migration.tag).join(", ")}).`);
  process.exit(0);
}

// A draft migration may be tried locally before it is locked; building and CI still require the lock.
const migrations = orFail(() => readMigrations());
for (const problem of checkLock(migrations)) {
  console.warn(`Warning (npm run build and CI refuse this until resolved): ${problem}`);
}

const hosting = JSON.parse(readFileSync(path.join(projectRoot, ".openai", "hosting.json"), "utf8"));
if (!hosting.d1) fail(".openai/hosting.json declares no D1 binding.");
const builtConfigFile = path.join(projectRoot, "dist", "server", "wrangler.json");
if (!existsSync(builtConfigFile)) {
  fail("dist/server/wrangler.json is missing. Run `npm run build` first; local D1 commands use the binding the build generates.");
}
const built = JSON.parse(readFileSync(builtConfigFile, "utf8"));
const database = built.d1_databases?.find((candidate) => candidate.binding === hosting.d1);
if (!database) fail(`dist/server/wrangler.json has no D1 binding ${hosting.d1}. Rebuild after changing bindings.`);

// Wrangler resolves migrations_dir relative to its config file and the generated config sets
// none, so write a local-only copy that points the same local database at drizzle/.
const configDir = path.join(projectRoot, ".wrangler", "local-migrations");
const configFile = path.join(configDir, "wrangler.json");
mkdirSync(configDir, { recursive: true });
writeFileSync(configFile, `${JSON.stringify({
  name: built.name,
  compatibility_date: built.compatibility_date,
  d1_databases: [{
    binding: database.binding,
    database_name: database.database_name,
    database_id: database.database_id,
    migrations_dir: path.relative(configDir, migrationsDir).split(path.sep).join("/"),
  }],
}, null, 2)}\n`);

console.log(`Local preview D1 only (migrations: ${migrations.length} in drizzle/; state: .wrangler/state). Production is never contacted.`);
const result = spawnSync(process.execPath, [
  "--import", "./scripts/sites-env.mjs", "./node_modules/wrangler/bin/wrangler.js",
  "d1", "migrations", wranglerCommands[command], database.binding,
  "--local", "--persist-to", ".wrangler/state", "--config", configFile,
], {
  cwd: projectRoot,
  stdio: "inherit",
  // Defaults skip Wrangler's banner (and its npm update check) and telemetry.
  env: { WRANGLER_HIDE_BANNER: "true", WRANGLER_SEND_METRICS: "false", WRANGLER_SEND_ERROR_REPORTS: "false", ...process.env },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
