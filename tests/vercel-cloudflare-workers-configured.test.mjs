// lib/vercel-cloudflare-workers.ts, the module next.config.ts aliases in place of
// `cloudflare:workers` on Vercel: with TURSO_DATABASE_URL and TURSO_AUTH_TOKEN both set, env.DB
// resolves to a working Turso-backed database (proven against @libsql/client local ":memory:" mode -
// no real Turso account exists for this project). A separate file from the "unconfigured" case
// because the module reads process.env once at import time and node:test isolates each test file
// into its own process, giving each scenario a clean module cache without cache-busting tricks.
import assert from 'node:assert/strict';
import { test } from 'node:test';
// Registers the .ts-extension resolution hook this module's relative import ('./turso-db') needs.
import './helpers/harness.mjs';

process.env.TURSO_DATABASE_URL = ':memory:';
process.env.TURSO_AUTH_TOKEN = 'unused-for-local-mode';
process.env.X_BEARER_TOKEN = 'x-token-value';
process.env.GOLDMINE_CRON_SECRET = 'cron-secret-value';
process.env.CRON_SECRET = 'bearer-secret-value';

const { env } = await import('../lib/vercel-cloudflare-workers.ts');

test('env.DB is present and is a working D1-shaped database when Turso credentials are configured', async () => {
  assert.ok(env.DB);
  await env.DB.prepare('CREATE TABLE probe (id TEXT PRIMARY KEY)').run();
  const inserted = await env.DB.prepare('INSERT INTO probe (id) VALUES (?)').bind('a').run();
  assert.equal(inserted.meta.changes, 1);
  assert.deepEqual(await env.DB.prepare('SELECT id FROM probe').bind().first(), { id: 'a' });
});

test('provider secrets flow through from process.env, the same shape Cloudflare exposes on env', () => {
  assert.equal(env.X_BEARER_TOKEN, 'x-token-value');
  assert.equal(env.GOLDMINE_CRON_SECRET, 'cron-secret-value');
  assert.equal(env.CRON_SECRET, 'bearer-secret-value');
});

test('env is frozen, like the Cloudflare-side env object', () => {
  assert.ok(Object.isFrozen(env));
});
