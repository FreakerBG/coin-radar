// Durable trade-alert eligibility and outbox (lib/goldmine/alerts.ts). Policy (docs/detection-rollout-
// decisions.md): only verified, actionable opportunities; at most one alert per mint per rolling 24 hours;
// one exception for a genuine non-qualifying -> qualifying transition; never "delivered" before a sender
// confirms. No production sender exists - these tests drive fake channels.
import assert from 'node:assert/strict';
import {beforeEach, describe, test} from 'node:test';
import {addresses, body, createD1, failures, installFetch, jsonRequest, runtime, signIn, startClock} from './helpers/harness.mjs';
import {pair} from './helpers/goldmine-fixtures.mjs';

const {eligibility, recordAlertEligibility, claimNextAlert, markAlertDelivered, deliverNextAlert, ALERT_MAX_AGE_MS, ALERT_MAX_ATTEMPTS, ALERT_WINDOW_MS} = await import('../lib/goldmine/alerts.ts');

const {POST} = await import('../app/api/goldmine/scheduled/route.ts');
const {POST: scan} = await import('../app/api/goldmine/route.ts');

// A RugCheck report that verifies cleanly: with the reference BREAKOUT pair it makes a real opportunity.
const verifiedReport = {
  token: {mintAuthority: null, freezeAuthority: null, supply: 1_000_000_000, decimals: 6}, rugged: false, totalMarketLiquidity: 250000,
  topHolders: [{pct: 8}, {pct: 5}, {pct: 3}], creatorBalance: 10_000_000, graphInsidersDetected: 0, score_normalised: 5, risks: [],
  markets: [{lp: {quoteUSD: 50000, baseUSD: 50000, lpLockedPct: 95}}],
};

const MINUTE = 60000, HOUR = 60 * MINUTE;
let d1, clock;

// A scored entry in the only shape recordAlertEligibility reads.
function entry(kind, {address = addresses.tokenA, modelVersion = 'momentum-v2.1.0', state = 'BREAKOUT'} = {}) {
  const safety = {qualifying: 'verified', unsafe: 'unsafe', verifiedNotOpportunity: 'verified', uncertain: 'unavailable', rejected: 'unavailable'}[kind];
  return {
    snapshot: {contractSafety: {status: safety}},
    assessment: {address, modelVersion, state: kind === 'rejected' ? 'REJECTED' : state, opportunity: kind === 'qualifying', priceUsd: 1},
  };
}
const alerts = () => d1.rows('SELECT address, reason, status, created_at FROM goldmine_alert_outbox ORDER BY created_at, id');
const observe = (kind, at, options) => recordAlertEligibility(d1, [entry(kind, options)], at);

beforeEach(() => {
  clock = startClock();
  d1 = createD1();
  runtime.env.DB = d1;
  failures.length = 0;
});

describe('eligibility: only a fully verified, actionable opportunity qualifies', () => {
  test('classification', () => {
    assert.equal(eligibility(entry('qualifying')), 'qualifying');
    for (const kind of ['unsafe', 'verifiedNotOpportunity', 'rejected']) assert.equal(eligibility(entry(kind)), 'not_qualifying', kind);
    assert.equal(eligibility(entry('uncertain')), 'uncertain');
    // Defense in depth: an opportunity flag without verified safety never qualifies.
    const flagged = entry('uncertain');
    flagged.assessment.opportunity = true;
    assert.equal(eligibility(flagged), 'uncertain');
  });

  test('rejected, unsafe and safety-uncertain observations never queue an alert; they stay research data', async () => {
    const t = Date.now();
    for (const [i, kind] of ['rejected', 'unsafe', 'uncertain', 'verifiedNotOpportunity'].entries()) assert.equal(await observe(kind, t + i * 15 * MINUTE), 0);
    assert.deepEqual(alerts(), []);
  });
});

describe('rolling 24-hour policy per mint', () => {
  test('first qualification queues one alert; a day of repeated 15-minute sightings queues nothing more; after 24 h one more', async () => {
    const t0 = Date.now();
    assert.equal(await observe('qualifying', t0), 1);
    let queued = 0;
    for (let i = 1; i < 96; i++) queued += await observe('qualifying', t0 + i * 15 * MINUTE);
    assert.equal(queued, 0, 'repeated sightings and score fluctuation do not re-alert');
    assert.equal(await observe('qualifying', t0 + ALERT_WINDOW_MS + MINUTE), 1);
    assert.deepEqual(alerts().map(a => a.reason), ['first', 'window']);
  });

  test('a genuine non-qualifying -> qualifying transition inside 24 h alerts once; a second flap the same day does not', async () => {
    const t0 = Date.now();
    await observe('qualifying', t0);
    await observe('unsafe', t0 + HOUR);
    assert.equal(await observe('qualifying', t0 + 2 * HOUR), 1, 'newly qualifying after an assessed non-qualifying observation');
    await observe('verifiedNotOpportunity', t0 + 3 * HOUR);
    assert.equal(await observe('qualifying', t0 + 4 * HOUR), 0, 'at most one transition alert per 24 h');
    assert.deepEqual(alerts().map(a => a.reason), ['first', 'transition']);
  });

  test('a safety-uncertain gap (RugCheck rate limit, cooldown, outage) is not a transition', async () => {
    const t0 = Date.now();
    await observe('qualifying', t0);
    await observe('uncertain', t0 + 15 * MINUTE);
    assert.equal(await observe('qualifying', t0 + 30 * MINUTE), 0);
    assert.equal(alerts().length, 1);
  });

  test('a non-qualifying observation from before the last alert does not count as a transition', async () => {
    const t0 = Date.now();
    await observe('unsafe', t0);
    await observe('qualifying', t0 + HOUR);   // first
    assert.equal(await observe('qualifying', t0 + 2 * HOUR), 0);
    assert.deepEqual(alerts().map(a => a.reason), ['first']);
  });

  test('a model-version change does not reset the per-mint window', async () => {
    const t0 = Date.now();
    await observe('qualifying', t0, {modelVersion: 'momentum-v2.1.0'});
    assert.equal(await observe('qualifying', t0 + HOUR, {modelVersion: 'momentum-v3.0.0'}), 0);
  });

  test('policy is per mint: another mint qualifies independently', async () => {
    const t0 = Date.now();
    await observe('qualifying', t0);
    assert.equal(await observe('qualifying', t0 + MINUTE, {address: addresses.tokenB}), 1);
  });
});

describe('idempotency under retries, restarts, duplicates and concurrency', () => {
  test('the same detection retried queues the alert once', async () => {
    const t0 = Date.now();
    assert.equal(await observe('qualifying', t0), 1);
    assert.equal(await observe('qualifying', t0), 0);
    assert.equal(alerts().length, 1);
  });

  test('a crash between the alert decision and the state write is resolved by the retry without a duplicate', async () => {
    const t0 = Date.now();
    await observe('qualifying', t0);
    await observe('unsafe', t0 + HOUR);
    d1.beforeQuery = sql => { if (sql.startsWith('INSERT INTO goldmine_alert_state')) throw new Error('process killed'); };
    await assert.rejects(observe('qualifying', t0 + 2 * HOUR), /process killed/);
    d1.beforeQuery = null;
    assert.equal(alerts().length, 2, 'the transition alert was queued before the crash');
    assert.equal(await observe('qualifying', t0 + 2 * HOUR + 15 * MINUTE), 0, 'the retry sees it and adds nothing');
    assert.equal(alerts().length, 2);
  });

  test('two overlapping runs (interleaved statements) queue exactly one alert', async () => {
    const t0 = Date.now();
    const results = await Promise.all([observe('qualifying', t0), observe('qualifying', t0 + 7 * HOUR / 7 + 1)]);
    assert.deepEqual(results.sort(), [0, 1]);
    assert.equal(alerts().length, 1);
  });
});

describe('outbox delivery never claims success it did not get', () => {
  const queue = async (at = Date.now()) => observe('qualifying', at);

  test('delivered only after the sender resolves; during send the row is still pending', async () => {
    await queue();
    let statusDuringSend;
    const outcome = await deliverNextAlert(d1, Date.now(), async alert => {
      statusDuringSend = d1.rows('SELECT status FROM goldmine_alert_outbox WHERE id = ?', alert.id)[0].status;
    });
    assert.equal(statusDuringSend, 'pending');
    assert.equal(outcome, 'delivered');
    assert.deepEqual(d1.rows('SELECT status, delivered_at IS NOT NULL AS stamped FROM goldmine_alert_outbox'), [{status: 'delivered', stamped: 1}]);
    assert.equal(await deliverNextAlert(d1, Date.now(), async () => { throw new Error('must not resend'); }), 'none');
  });

  test('a failed send stays undelivered, backs off, redacts its error and ends as failed after the attempt limit', async () => {
    await queue();
    runtime.env.CRON_SECRET = 'channel-secret-value'; // what lib/diagnostics.ts redact() reads
    let now = Date.now();
    for (let attempt = 1; attempt <= ALERT_MAX_ATTEMPTS; attempt++) {
      assert.equal(await deliverNextAlert(d1, now, async () => { throw new Error('channel down with channel-secret-value'); }), 'failed');
      assert.equal(await deliverNextAlert(d1, now, async () => {}), 'none', 'backoff: not retried immediately');
      now += 2 ** attempt * 30000 + 1; // exactly past this attempt's backoff; all five fit inside ALERT_MAX_AGE_MS
    }
    const [row] = d1.rows('SELECT status, attempts, delivered_at, last_error FROM goldmine_alert_outbox');
    delete runtime.env.CRON_SECRET;
    assert.deepEqual([row.status, row.attempts, row.delivered_at], ['failed', ALERT_MAX_ATTEMPTS, null]);
    assert.equal(row.last_error.includes('channel-secret-value'), false);
  });

  test('a claimed alert is leased: a second worker cannot take it, and a stale claim cannot mark it delivered', async () => {
    await queue();
    const now = Date.now();
    const first = await claimNextAlert(d1, now);
    assert.ok(first);
    assert.equal(await claimNextAlert(d1, now + 1000), null, 'still leased');
    const second = await claimNextAlert(d1, now + 2 * MINUTE);   // lease expired
    assert.ok(second);
    assert.equal(await markAlertDelivered(d1, first, now + 2 * MINUTE), false, 'the expired claim no longer owns it');
    assert.equal(await markAlertDelivered(d1, second, now + 2 * MINUTE), true);
  });

  test('an alert older than ALERT_MAX_AGE_MS expires instead of being sent late', async () => {
    const queuedAt = Date.now();
    await queue(queuedAt);
    assert.equal(await deliverNextAlert(d1, queuedAt + ALERT_MAX_AGE_MS + 1, async () => { throw new Error('must not send'); }), 'none');
    assert.deepEqual(d1.rows('SELECT status FROM goldmine_alert_outbox'), [{status: 'expired'}]);
  });
});

describe('wired into detection', () => {
  const request = () => new Request('https://coin-radar.test/api/goldmine/scheduled', {method: 'POST', headers: {'x-goldmine-cron-secret': 'header-secret'}});

  beforeEach(() => {
    process.env.GOLDMINE_CRON_SECRET = 'header-secret';
    installFetch(url => {
      if (url.startsWith('https://api.dexscreener.com/token-profiles/')) return Response.json([{chainId: 'solana', tokenAddress: addresses.tokenA}]);
      if (url.startsWith('https://api.dexscreener.com/token-boosts/')) return Response.json([]);
      if (url.startsWith('https://api.dexscreener.com/tokens/v1/solana/')) return Response.json([pair({pairCreatedAt: Date.now() - 48 * HOUR})]);
      if (url.startsWith('https://api.rugcheck.xyz/v1/tokens/')) return Response.json(verifiedReport);
      throw new Error('Unexpected request ' + url);
    });
  });

  test('a detection reports how many alerts it queued and that no delivery channel is configured', async () => {
    const data = await body(await POST(request()));
    assert.equal(data.status, 'checked');
    assert.equal(data.opportunities, 1, 'the fixture is a real verified opportunity');
    assert.deepEqual(data.alerts, {queued: 1, delivery: 'not_configured'});
  });

  test('on a database without the 0002 tables, detection still succeeds; alert recording fails visibly (rollback compatibility)', async () => {
    d1.sqlite.exec('DROP TABLE goldmine_alert_outbox; DROP TABLE goldmine_alert_state;');
    const data = await body(await POST(request()));
    assert.equal(data.status, 'checked');
    assert.equal(data.tracking.newSignals, 1);
    assert.deepEqual(data.alerts, {queued: null, delivery: 'not_configured'});
    assert.deepEqual(failures.map(f => [f.route, f.operation]), [['goldmine', 'alert-eligibility']]);
  });
});

describe('a qualifying detection end to end', () => {
  test('the interactive route queues exactly one alert for a verified opportunity, then none on a repeat', async () => {
    signIn('user-a');
    installFetch(url => {
      if (url.startsWith('https://api.dexscreener.com/token-profiles/')) return Response.json([{chainId: 'solana', tokenAddress: addresses.tokenA}]);
      if (url.startsWith('https://api.dexscreener.com/token-boosts/')) return Response.json([]);
      if (url.startsWith('https://api.dexscreener.com/tokens/v1/solana/')) return Response.json([pair({pairCreatedAt: Date.now() - 48 * HOUR})]);
      if (url.startsWith('https://api.dexscreener.com/latest/dex/pairs/solana/')) return Response.json({pairs: []});
      if (url.startsWith('https://api.rugcheck.xyz/v1/tokens/')) return Response.json(verifiedReport);
      throw new Error('Unexpected request ' + url);
    });
    const first = await body(await scan(jsonRequest('/api/goldmine', {method: 'POST', body: {}})));
    assert.equal(first.status, 'checked');
    assert.equal(first.alerts.queued, first.opportunities);
    const queuedAfterFirst = alerts().length;
    assert.equal(queuedAfterFirst, first.opportunities);
    clock.advance(15 * MINUTE);
    const second = await body(await scan(jsonRequest('/api/goldmine', {method: 'POST', body: {}})));
    assert.equal(second.alerts.queued, 0);
    assert.equal(alerts().length, queuedAfterFirst);
  });
});
