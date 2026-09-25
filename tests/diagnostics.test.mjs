// lib/diagnostics.ts and the failure records the routes write. A record names the route, operation and
// error, and never contains credentials, user identifiers or email addresses. Responses are unchanged.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {beforeEach, describe, test} from 'node:test';
import {addresses, body, createD1, failures, installFetch, jsonRequest, runtime, signIn, startClock} from './helpers/harness.mjs';

const {redact, reportFailure} = await import('../lib/diagnostics.ts');
const portfolio = await import('../app/api/portfolio/route.ts');
const advisor = await import('../app/api/advisor/route.ts');
const monitor = await import('../app/api/monitor/route.ts');
const social = await import('../app/api/social/route.ts');
const market = await import('../app/api/market/route.ts');
const news = await import('../app/api/news/route.ts');

const CREDENTIAL = 'offline-test-credential-0123456789';
const USER = 'user-diagnostics-7f3a';
const EMAIL = `${USER}@example.test`;
const GOLDMINE_HEADER_SECRET = 'offline-goldmine-cron-secret-9c1f';
const VERCEL_BEARER_SECRET = 'offline-vercel-cron-secret-4b2e';

let d1;
beforeEach(() => {
  startClock();
  d1 = createD1();
  runtime.env.DB = d1;
  runtime.env.X_BEARER_TOKEN = CREDENTIAL;
  runtime.env.GOLDMINE_CRON_SECRET = GOLDMINE_HEADER_SECRET;
  runtime.env.CRON_SECRET = VERCEL_BEARER_SECRET;
  failures.length = 0;
  signIn(USER);
});

const summary = () => failures.map(failure => [failure.route, failure.operation, failure.level, failure.error.message]);
function assertPrivate() {
  const text = JSON.stringify(failures);
  for (const value of [CREDENTIAL, USER, EMAIL, GOLDMINE_HEADER_SECRET, VERCEL_BEARER_SECRET]) {
    assert.equal(text.includes(value), false, `a failure record contains ${value}`);
  }
}

describe('failure records', () => {
  test('redact removes the configured X credential, bearer tokens and email addresses, and truncates', () => {
    const redacted = redact(`Bearer abc.def-ghi failed for ${EMAIL} using ${CREDENTIAL} ${'x'.repeat(400)}`);
    assert.match(redacted, /^Bearer \[redacted\] failed for \[email\] using \[redacted\] x+$/);
    assert.equal(redacted.length, 300);
    assert.equal(redact('BEARER abc, bearer def; Authorization: Bearer ghi'), 'Bearer [redacted] Bearer [redacted] Authorization: Bearer [redacted]');
  });

  // The generic `Bearer <token>` pattern above already catches CRON_SECRET wherever it is sent with
  // that prefix (Vercel Cron's own convention). GOLDMINE_CRON_SECRET travels as a bare header value
  // with no prefix (lib/goldmine/scheduled-auth.ts), so it needs its own exact-value redaction, same as
  // X_BEARER_TOKEN gets - otherwise a message that echoes a rejected header value verbatim would leak
  // it. CRON_SECRET is redacted the same explicit way too, as defense-in-depth beyond the generic
  // Bearer pattern, for a message that might one day echo it without that prefix.
  test('redact also removes the configured Goldmine scheduled-scan secrets, with or without the Bearer prefix', () => {
    assert.equal(redact(`rejected header value ${GOLDMINE_HEADER_SECRET} for scheduled scan`), 'rejected header value [redacted] for scheduled scan');
    assert.equal(redact(`rejected raw secret ${VERCEL_BEARER_SECRET} for scheduled scan`), 'rejected raw secret [redacted] for scheduled scan');
    assert.equal(redact(`Authorization: Bearer ${VERCEL_BEARER_SECRET}`), 'Authorization: Bearer [redacted]');
  });

  test('one JSON line per failure, at the requested level, including a redacted cause', () => {
    reportFailure('route-x', 'operation-y', new Error('outer', {cause: new TypeError(`inner ${CREDENTIAL}`)}));
    reportFailure('route-x', 'provider', 'plain value', 'warn');
    assert.deepEqual(failures, [
      {event: 'coin_radar.failure', level: 'error', route: 'route-x', operation: 'operation-y', error: {name: 'Error', message: 'outer', cause: {name: 'TypeError', message: 'inner [redacted]'}}},
      {event: 'coin_radar.failure', level: 'warn', route: 'route-x', operation: 'provider', error: {name: 'string', message: 'plain value'}},
    ]);
  });

  test('reporting never throws, even for a value that cannot be described', () => {
    const unreadable = new Error('hidden');
    Object.defineProperty(unreadable, 'message', {get() { throw new Error('message getter failed'); }});
    for (const value of [Object.create(null), unreadable]) assert.doesNotThrow(() => reportFailure('route-x', 'operation-y', value));
    assert.deepEqual(failures.map(failure => [failure.route, failure.operation, failure.error.name]), [['route-x', 'operation-y', 'unknown'], ['route-x', 'operation-y', 'unknown']]);
  });
});

describe('routes report failures without changing their responses', () => {
  test('portfolio storage failures on load and save; validation errors are not failures', async () => {
    const config = {bankroll: 1, riskPct: 1, maxAllocationPct: 5, takeProfitPct: 50, stopPct: 20, trailingPct: 15, liquidityDropPct: 30, xDailyRequests: 0};
    const save = payload => portfolio.POST(jsonRequest('/api/portfolio', {method: 'POST', body: payload}));
    assert.equal((await save({action: 'config', config: {...config, bankroll: -1}})).status, 400);
    assert.deepEqual(failures, []);

    d1.beforeQuery = () => { throw new Error('D1_ERROR: database is locked'); };
    const loaded = await portfolio.GET();
    assert.deepEqual([loaded.status, (await body(loaded)).error], [503, 'Research storage unavailable. Your saved positions have not been changed.']);
    assert.equal((await save({action: 'config', config})).status, 503);
    assert.deepEqual(summary(), [
      ['portfolio', 'load', 'error', 'D1_ERROR: database is locked'],
      ['portfolio', 'save', 'error', 'D1_ERROR: database is locked'],
    ]);
    assertPrivate();
  });

  test('advisor evidence failure', async () => {
    installFetch(() => new Response('unavailable', {status: 503}));
    const response = await advisor.GET(jsonRequest(`/api/advisor?address=${addresses.tokenA}`));
    assert.deepEqual([response.status, (await body(response)).error], [503, 'Evidence unavailable. No allocation suggested.']);
    assert.deepEqual(summary(), [['advisor', 'evidence', 'error', 'Provider returned 503']]);
  });

  test('monitor: a provider outage is a warning; a storage failure and a failed lock release are errors', async () => {
    const id = randomUUID();
    d1.sqlite.prepare('INSERT INTO research_positions (id, user_id, data) VALUES (?, ?, ?)').run(id, USER, JSON.stringify({
      id, address: addresses.tokenA, pair: addresses.pairA, symbol: 'FIX', entryPrice: 1, amount: 10, quantity: 10, peakPrice: 1, entryLiquidity: 1000,
      takeProfitPct: 50, stopPct: 20, trailingPct: 15, liquidityDropPct: 30, openedAt: '2026-01-01T00:00:00.000Z', closedAt: null, lastPrice: null, lastCheckedAt: null,
    }));
    installFetch(() => { throw new TypeError('network down'); });
    const scan = () => monitor.POST(jsonRequest('/api/monitor', {method: 'POST', body: {}}));
    const outage = await scan();
    assert.deepEqual([outage.status, (await body(outage)).status], [200, 'provider_unavailable']);
    assert.deepEqual(summary(), [['monitor', 'provider', 'warn', 'network down']]);

    failures.length = 0;
    d1.beforeQuery = sql => {
      if (sql.startsWith('UPDATE research_positions') || sql.startsWith('DELETE FROM research_locks')) throw new Error('D1_ERROR: write failed');
    };
    assert.equal((await scan()).status, 503);
    assert.deepEqual(summary(), [
      ['monitor', 'provider', 'warn', 'network down'],
      ['monitor', 'scan', 'error', 'D1_ERROR: write failed'],
      ['monitor', 'release-lock', 'error', 'D1_ERROR: write failed'],
    ]);
    assertPrivate();
  });

  test('social: an X HTTP error is a warning; malformed X data and storage failures are errors', async () => {
    d1.sqlite.prepare('INSERT INTO research_accounts (user_id, config) VALUES (?, ?)').run(USER, JSON.stringify({xDailyRequests: 10}));
    const research = address => social.POST(jsonRequest('/api/social', {method: 'POST', body: {address}}));
    installFetch(() => new Response('rate limited', {status: 429}));
    assert.equal((await research(addresses.tokenA)).status, 502);
    installFetch(() => Response.json({errors: [{title: `Unauthorized: Bearer ${CREDENTIAL}`}]}));
    assert.equal((await research(addresses.tokenB)).status, 503);
    d1.beforeQuery = sql => { if (sql.startsWith('SELECT requests')) throw new Error(`D1_ERROR: failed with Bearer ${CREDENTIAL} for ${EMAIL}`); };
    assert.equal((await social.GET(jsonRequest('/api/social'))).status, 503);
    assert.deepEqual(summary(), [
      ['social', 'x-search', 'warn', 'X returned 429'],
      ['social', 'research', 'error', 'X returned errors without data'],
      ['social', 'load', 'error', 'D1_ERROR: failed with Bearer [redacted] for [email]'],
    ]);
    assertPrivate();
  });

  test('market and news provider failures are warnings', async () => {
    installFetch(() => new Response('down', {status: 500}));
    assert.equal((await market.GET(jsonRequest('/api/market?q=fixture'))).status, 502);
    assert.equal((await news.GET()).status, 502);
    assert.deepEqual(summary(), [
      ['market', 'provider', 'warn', 'Provider returned 500'],
      ['news', 'provider', 'warn', 'CoinDesk returned 500'],
    ]);
  });
});
