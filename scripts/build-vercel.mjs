import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { MigrationCheckError, verifyMigrations } from "./migrations.mjs";

// The Vercel deployment applies these same migrations to Turso (scripts/migrate-turso.mjs), so this
// build refuses a malformed migration history or a rewritten locked migration for exactly the reason
// the Cloudflare build does (scripts/run-framework.mjs). Files only - no database, no network, and
// nothing here reaches Turso: it reads drizzle/ and db/migrations.lock.json and compares hashes.
try {
  verifyMigrations();
} catch (error) {
  if (!(error instanceof MigrationCheckError)) throw error;
  console.error(error.message);
  process.exit(1);
}

// vinext and Next.js both use `.next` for generated metadata, but their
// contents are not interchangeable when developers run both builds locally.
await rm(".next", { recursive: true, force: true });

const child = spawn(
  process.execPath,
  ["./node_modules/next/dist/bin/next", "build"],
  {
    env: { ...process.env, VERCEL: "1" },
    stdio: "inherit",
  },
);

child.on("error", error => {
  console.error(error);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Vercel build stopped by ${signal}.`);
    process.exitCode = 1;
    return;
  }

  process.exitCode = code ?? 1;
});
