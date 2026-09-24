// Two claims the runbook makes about the Vercel deployment, asserted rather than asserted-in-prose.
//
// 1. "The Turso client is never constructed during a build." That was untrue: lib/turso-db.ts built
//    the libSQL client in createTursoDatabase(), which lib/vercel-cloudflare-workers.ts calls at
//    module scope - and Next.js evaluates module scope during `next build` to collect page data. A
//    build therefore depended on TURSO_DATABASE_URL being well formed. The client is now built on
//    first statement execution instead.
// 2. The scheduler endpoint is authorized by a shared secret and by nothing else - not by a session
//    cookie, not by a forged Sites identity header, not by anything in the request the caller
//    controls.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createD1, installFetch, offlineFetch, runtime, startClock } from './helpers/harness.mjs';

const { createTursoDatabase } = await import('../lib/turso-db.ts');
const { isAuthorizedScheduledScan } = await import('../lib/goldmine/scheduled-auth.ts');
const { SESSION_COOKIE, createOwnerSession } = await import('../app/owner-auth.ts');
const { GET: scheduledGet, POST: scheduledPost } = await import('../app/api/goldmine/scheduled/route.ts');

const ORIGIN = 'https://coin-radar.test';
const ORIGINAL_CRON = process.env.GOLDMINE_CRON_SECRET;
const ORIGINAL_BEARER = process.env.CRON_SECRET;

describe('the Turso client is not constructed until a statement runs', () => {
  test('an unreachable or malformed database URL does not throw while building statements', () => {
    // If the client were constructed eagerly, this line would throw for a URL libSQL rejects - and it
    // would throw during `next build`, because lib/vercel-cloudflare-workers.ts calls this at module
    // scope. Building a statement must stay inert.
    for (const url of ['not-a-url', 'libsql://host-that-does-not-exist.turso.io', 'https://127.0.0.1:1/db']) {
      const database = createTursoDatabase({ url, authToken: 'unused' });
      const statement = database.prepare('SELECT 1').bind();
      assert.equal(typeof statement.first, 'function', url);
    }
  });

  test('a configured client still works once a statement actually runs', async () => {
    const database = createTursoDatabase({ url: ':memory:', authToken: '' });
    await database.prepare('CREATE TABLE probe (id TEXT PRIMARY KEY)').run();
    const inserted = await database.prepare('INSERT INTO probe (id) VALUES (?)').bind('a').run();
    assert.equal(inserted.meta.changes, 1);
    assert.deepEqual(await database.prepare('SELECT id FROM probe').first(), { id: 'a' });
  });

  test('the same database object reuses one client across statements', async () => {
    // Per warm serverless instance, not per statement: a new client per query would open a new
    // connection every time and burn through the 1,024 file-descriptor limit under load.
    const database = createTursoDatabase({ url: ':memory:', authToken: '' });
    await database.prepare('CREATE TABLE probe (id TEXT PRIMARY KEY)').run();
    await database.prepare('INSERT INTO probe (id) VALUES (?)').bind('a').run();
    // An in-memory database is per-connection, so seeing the row back proves the connection was reused.
    assert.deepEqual(await database.prepare('SELECT id FROM probe').first(), { id: 'a' });
  });
});

describe('the scheduled scan is authorized by the shared secret and by nothing else', () => {
  let d1;
  beforeEach(() => {
    startClock();
    d1 = createD1();
    runtime.env.DB = d1;
    installFetch(offlineFetch);
    runtime.headers = new Headers();
    process.env.GOLDMINE_CRON_SECRET = 'header-secret';
    process.env.CRON_SECRET = 'bearer-secret';
    process.env.AUTH_SECRET = 'test-secret';
  });
  afterEach(() => {
    delete process.env.VERCEL;
    delete process.env.AUTH_SECRET;
    if (ORIGINAL_CRON === undefined) delete process.env.GOLDMINE_CRON_SECRET; else process.env.GOLDMINE_CRON_SECRET = ORIGINAL_CRON;
    if (ORIGINAL_BEARER === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = ORIGINAL_BEARER;
  });

  const request = (headers = {}) => new Request(`${ORIGIN}/api/goldmine/scheduled`, { method: 'GET', headers });

  test('a valid owner session cookie does not authorize a scheduled scan', async () => {
    // The scheduler path must not become a second way to run a scan as a signed-in user, and a
    // signed-in browser must not be able to drive the cron endpoint.
    const cookie = `${SESSION_COOKIE}=${createOwnerSession()}`;
    assert.equal(isAuthorizedScheduledScan(request({ cookie })), false);
    const response = await scheduledGet(request({ cookie }));
    assert.equal(response.status, 401);
    assert.equal(d1.queries.length, 0, 'rejected before any storage query');
  });

  test('forged Sites identity headers do not authorize a scheduled scan', async () => {
    const headers = {
      'oai-authenticated-user-id': 'attacker',
      'oai-authenticated-user-email': 'attacker@example.test',
    };
    assert.equal(isAuthorizedScheduledScan(request(headers)), false);
    assert.equal((await scheduledGet(request(headers))).status, 401);
  });

  test('a secret supplied anywhere the caller controls other than the two accepted headers is ignored', async () => {
    for (const headers of [
      { 'x-goldmine-cron-secret-x': 'header-secret' },
      { 'x-cron-secret': 'header-secret' },
      { authorization: 'header-secret' },              // right value, no Bearer scheme
      { authorization: 'Basic bearer-secret' },        // wrong scheme
      { authorization: 'bearer bearer-secret' },       // scheme is case-sensitive here
      { authorization: 'Bearer  bearer-secret' },      // extra space becomes part of the secret
      { 'x-goldmine-cron-secret': 'header-secretx' },     // a longer value is not a prefix match
      { 'x-goldmine-cron-secret': 'header-secre' },      // nor is a shorter one
      { 'x-vercel-cron': '1' },                        // a platform hint is not a credential
    ]) {
      assert.equal(isAuthorizedScheduledScan(request(headers)), false, JSON.stringify(headers));
    }
  });

  test('leading and trailing whitespace is stripped by HTTP before the check sees the value', () => {
    // Standard Headers/HTTP behaviour - optional whitespace around a field value is not part of it.
    // Recorded so it is a known property of the check rather than a surprise: padding cannot smuggle a
    // wrong secret past the comparison, and padding a correct one does not break it.
    assert.equal(isAuthorizedScheduledScan(request({ 'x-goldmine-cron-secret': ' header-secret ' })), true);
  });

  test('an empty secret value never authorizes, on either convention', () => {
    assert.equal(isAuthorizedScheduledScan(request({ 'x-goldmine-cron-secret': '' })), false);
    assert.equal(isAuthorizedScheduledScan(request({ authorization: 'Bearer ' })), false);

    process.env.GOLDMINE_CRON_SECRET = '';
    process.env.CRON_SECRET = '';
    assert.equal(isAuthorizedScheduledScan(request({ 'x-goldmine-cron-secret': '' })), false);
    assert.equal(isAuthorizedScheduledScan(request({ authorization: 'Bearer ' })), false);
  });

  test('a request body cannot carry the secret: only headers are read', async () => {
    const withBody = new Request(`${ORIGIN}/api/goldmine/scheduled`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: 'header-secret', cronSecret: 'bearer-secret', authorization: 'Bearer bearer-secret' }),
    });
    assert.equal((await scheduledPost(withBody)).status, 401);
  });

  test('a query parameter cannot carry the secret either', async () => {
    const withQuery = new Request(`${ORIGIN}/api/goldmine/scheduled?secret=header-secret&cron_secret=bearer-secret`, { method: 'GET' });
    assert.equal((await scheduledGet(withQuery)).status, 401);
  });

  test('an unauthorized response is no-store and says nothing about which secrets are configured', async () => {
    const response = await scheduledGet(request());
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const text = await response.text();
    assert.equal(text, JSON.stringify({ error: 'Not authorized.' }));
    for (const leak of ['GOLDMINE_CRON_SECRET', 'CRON_SECRET', 'header-secret', 'bearer-secret']) {
      assert.equal(text.includes(leak), false, `response leaked ${leak}`);
    }
  });
});
