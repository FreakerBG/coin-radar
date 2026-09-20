// lib/vercel-cloudflare-workers.ts must also fail closed when only one of TURSO_DATABASE_URL /
// TURSO_AUTH_TOKEN is set - a half-configured deployment must never silently degrade to a fake or
// partially working database.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers/harness.mjs';

process.env.TURSO_DATABASE_URL = ':memory:';
delete process.env.TURSO_AUTH_TOKEN;

const { env } = await import('../lib/vercel-cloudflare-workers.ts');

test('env.DB is absent when TURSO_AUTH_TOKEN is missing, even with a database URL configured', () => {
  assert.equal(env.DB, undefined);
});
