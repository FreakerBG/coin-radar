// lib/vercel-cloudflare-workers.ts must fail closed - env.DB absent, never a fake/degraded database -
// when Turso credentials are missing entirely. This is the state every Vercel deployment is in today
// (no real Turso account exists yet for this project), so this is the default, must-never-regress case.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers/harness.mjs';

delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.X_BEARER_TOKEN;
delete process.env.GOLDMINE_CRON_SECRET;
delete process.env.CRON_SECRET;

const { env } = await import('../lib/vercel-cloudflare-workers.ts');

test('env.DB is absent (falsy) with no Turso credentials, so D1-backed routes fail closed as before', () => {
  assert.equal(env.DB, undefined);
  assert.equal(!env.DB, true);
});

test('unset provider secrets are simply absent from env, not empty strings or undefined-but-present keys', () => {
  assert.equal(env.X_BEARER_TOKEN, undefined);
  assert.equal(env.GOLDMINE_CRON_SECRET, undefined);
  assert.equal(env.CRON_SECRET, undefined);
  assert.equal(Object.hasOwn(env, 'X_BEARER_TOKEN'), false);
  assert.equal(Object.hasOwn(env, 'CRON_SECRET'), false);
});

test('env is frozen and empty', () => {
  assert.ok(Object.isFrozen(env));
  assert.deepEqual({ ...env }, {});
});
