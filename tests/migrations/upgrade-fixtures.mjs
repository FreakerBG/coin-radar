// Upgrade-path coverage: one entry per migration in drizzle/meta/_journal.json, in order (enforced by
// upgrade.test.mjs). seed(sqlite) writes representative rows that are valid right after that migration;
// verify(sqlite) proves the real routes still serve those rows correctly at the current schema.
// A migration that intentionally rewrites existing data lists what it changes in `changes`
// ({"table" or "table.column": reason}); any other change to pre-existing data fails the upgrade test.
import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {addresses, body, createD1, installFetch, jsonRequest, runtime, signIn} from '../helpers/harness.mjs';

const userA = 'user-a', userB = 'user-b';
const ids = {
  aOpen: '11111111-1111-4111-8111-111111111111',
  aClosed: '22222222-2222-4222-8222-222222222222',
  bOpen: '33333333-3333-4333-8333-333333333333',
};
const goldmine = {recent: 'momentum-v2.0.0:recent-signal', old: 'momentum-v2.0.0:old-signal'};
const configA = {bankroll: 1000, riskPct: 2, maxAllocationPct: 5, takeProfitPct: 50, stopPct: 25, trailingPct: 30, liquidityDropPct: 50, xDailyRequests: 10};
const utcDay = time => new Date(time).toISOString().slice(0, 10);

function insert(sqlite, table, row) {
  const names = Object.keys(row);
  sqlite.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...Object.values(row));
}

export const upgradeFixtures = {
  '0000_rare_terror': {
    seed(sqlite) {
      const now = Date.now(), at = new Date(now).toISOString();
      insert(sqlite, 'research_accounts', {user_id: userA, config: JSON.stringify(configA), revision: 3});
      // A partial stored config: getConfig fills the missing settings from defaults.
      insert(sqlite, 'research_accounts', {user_id: userB, config: JSON.stringify({bankroll: 250, riskPct: 2}), revision: 0});

      const position = (id, overrides = {}) => JSON.stringify({
        id, address: addresses.tokenA, pair: addresses.pairA, symbol: 'FIX', entryPrice: 1, amount: 100, quantity: 100, peakPrice: 1.2,
        entryLiquidity: 100000, takeProfitPct: 50, stopPct: 25, trailingPct: 30, liquidityDropPct: 50,
        openedAt: at, closedAt: null, lastPrice: 1.1, lastCheckedAt: at, ...overrides,
      });
      insert(sqlite, 'research_positions', {id: ids.aOpen, user_id: userA, data: position(ids.aOpen), closed_at: null, revision: 7});
      insert(sqlite, 'research_positions', {id: ids.aClosed, user_id: userA, data: position(ids.aClosed), closed_at: at, revision: 2});
      // Another user's open position on the same pool.
      insert(sqlite, 'research_positions', {id: ids.bOpen, user_id: userB, data: position(ids.bOpen, {amount: 40, quantity: 40}), closed_at: null, revision: 0});

      for (const [positionId, userId, kind] of [[ids.aOpen, userA, 'loss_threshold'], [ids.bOpen, userB, 'liquidity_drop']]) {
        const id = `${positionId}:${kind}`;
        insert(sqlite, 'research_events', {
          id, user_id: userId, position_id: positionId, kind, created_at: at,
          data: JSON.stringify({kind, severity: 'urgent', message: 'Recorded before the upgrade.', id, positionId, address: addresses.tokenA, symbol: 'FIX', time: at, price: 0.72}),
        });
      }

      // Left behind by a scan that stopped before releasing it.
      insert(sqlite, 'research_locks', {id: `monitor:${userA}`, owner: 'interrupted-scan', expires: now - 1000});

      // Written before the Stage 02 isolation fix: the shared row carried its writer's quota and state.
      insert(sqlite, 'social_cache', {address: addresses.tokenA, fetched_at: now - 60000, data: JSON.stringify({
        address: addresses.tokenA, asOf: at,
        posts: [{text: 'Public contract evidence', date: at, url: 'https://x.com/i/status/1', author: 'public-author', requester: userA}],
        summary: {sampleSize: 1, uniqueAuthors: 1, duplicateText: 0, engagement: 3, warning: 'Bounded sample.', requesterQuota: 10},
        status: 'connected', configured: true, cached: false, stale: false, message: 'LEGACY MESSAGE', usedToday: 99, dailyLimit: 99, userId: userA,
      })});
      // Current public-only shape, older than the 15-minute freshness window.
      insert(sqlite, 'social_cache', {address: addresses.tokenB, fetched_at: now - 3600000, data: JSON.stringify({
        address: addresses.tokenB, asOf: at, posts: [], summary: {sampleSize: 0, uniqueAuthors: 0, duplicateText: 0, engagement: 0, warning: 'Bounded sample.'},
      })});

      insert(sqlite, 'social_usage', {id: `x:${userA}:${utcDay(now)}`, requests: 4});
      insert(sqlite, 'social_usage', {id: `x:${userB}:${utcDay(now)}`, requests: 1});
      insert(sqlite, 'social_usage', {id: `x:${userA}:${utcDay(now - 86400000)}`, requests: 9});
    },

    async verify(sqlite) {
      const portfolio = await import('../../app/api/portfolio/route.ts');
      const monitor = await import('../../app/api/monitor/route.ts');
      const social = await import('../../app/api/social/route.ts');
      const health = await import('../../app/api/health/route.ts');
      const {defaultConfig} = await import('../../lib/advisor.ts');
      const d1 = createD1(sqlite);
      runtime.env.DB = d1;
      runtime.env.X_BEARER_TOKEN = 'offline-test-credential';
      let pools = [];
      const calls = installFetch(url => url.startsWith('https://api.x.com/')
        ? Response.json({data: [{id: '301', text: 'Post after the upgrade', author_id: 'author-1', created_at: new Date().toISOString()}]})
        : Response.json({pairs: pools}));
      const post = (route, path, payload) => route.POST(jsonRequest(path, {method: 'POST', body: payload}));

      // The post-deployment health check passes on the upgraded database.
      signIn(userA);
      assert.equal((await body(await health.GET())).schema, 'compatible');

      // Portfolio: each user loads only their own settings, open positions and events.
      const a = await body(await portfolio.GET());
      assert.deepEqual(a.config, {...defaultConfig, ...configA});
      assert.deepEqual([a.positions.map(p => p.id), a.events.map(e => e.id)], [[ids.aOpen], [`${ids.aOpen}:loss_threshold`]]);
      signIn(userB);
      const b = await body(await portfolio.GET());
      assert.deepEqual(b.config, {...defaultConfig, bankroll: 250, riskPct: 2});
      assert.deepEqual([b.positions.map(p => p.id), b.events.map(e => e.id)], [[ids.bOpen], [`${ids.bOpen}:liquidity_drop`]]);

      // Writes to upgraded rows keep ownership checks and revision counters.
      assert.deepEqual(await body(await post(portfolio, '/api/portfolio', {action: 'close', id: ids.aOpen})), {ok: false}, 'another user cannot close it');
      assert.deepEqual(await body(await post(portfolio, '/api/portfolio', {action: 'config', config: {...defaultConfig, bankroll: 250, riskPct: 2}})), {ok: true});
      assert.deepEqual(d1.rows('SELECT user_id, revision FROM research_accounts ORDER BY user_id'), [{user_id: userA, revision: 3}, {user_id: userB, revision: 1}]);

      // Monitoring: the pre-upgrade event is not repeated, a new rule is recorded, the stale lock is taken over.
      signIn(userA);
      pools = [{chainId: 'solana', pairAddress: addresses.pairA, baseToken: {address: addresses.tokenA}, priceUsd: '0.7', liquidity: {usd: 100000}}];
      const scan = await body(await post(monitor, '/api/monitor', {}));
      assert.equal(scan.status, 'checked');
      assert.deepEqual(scan.newEvents.map(e => [e.positionId, e.kind]), [[ids.aOpen, 'trailing_pullback']]);
      assert.deepEqual(d1.rows('SELECT id FROM research_events WHERE user_id = ? ORDER BY id', userA).map(row => row.id),
        [`${ids.aOpen}:loss_threshold`, `${ids.aOpen}:trailing_pullback`]);
      const [scanned] = d1.rows('SELECT data, revision FROM research_positions WHERE id = ?', ids.aOpen);
      assert.deepEqual([scanned.revision, JSON.parse(scanned.data).lastPrice, JSON.parse(scanned.data).peakPrice], [8, 0.7, 1.2]);
      assert.deepEqual(d1.rows('SELECT id, revision FROM research_positions WHERE id <> ? ORDER BY id', ids.aOpen),
        [{id: ids.aClosed, revision: 2}, {id: ids.bOpen, revision: 0}], 'closed and other users’ positions are untouched');
      assert.deepEqual(d1.rows('SELECT id FROM research_locks'), []);

      // Social: the pre-fix shared row is served as public evidence with each reader's own quota.
      for (const [userId, usedToday, dailyLimit] of [[userA, 4, 10], [userB, 1, 0]]) {
        signIn(userId);
        const cached = await body(await social.GET(jsonRequest(`/api/social?address=${addresses.tokenA}`)));
        assert.deepEqual([cached.cached, cached.stale, cached.usedToday, cached.dailyLimit], [true, false, usedToday, dailyLimit]);
        assert.deepEqual(cached.posts.map(post => Object.keys(post).sort()), [['author', 'date', 'text', 'url']]);
        assert.equal(/LEGACY|requester|userId/.test(JSON.stringify(cached)), false, 'no pre-fix private state is served');
      }
      // A stale row is refreshed once and charged to the caller's preserved usage row.
      signIn(userA);
      const refreshed = await body(await post(social, '/api/social', {address: addresses.tokenB}));
      assert.deepEqual([refreshed.status, refreshed.cached, refreshed.usedToday, refreshed.posts.length], ['connected', false, 5, 1]);
      assert.equal(calls.filter(call => call.url.startsWith('https://api.x.com/')).length, 1);
      assert.deepEqual(d1.rows('SELECT id, requests FROM social_usage ORDER BY id').map(row => row.requests), [9, 5, 1]);
    },
  },

  '0001_goldmine_signals': {
    seed(sqlite) {
      const now = Date.now(), minute = 60000, hour = 60 * minute;
      const signal = (id, address, pairAddress, state, detectedAt, price) => insert(sqlite, 'goldmine_signals', {
        id, address, pair: pairAddress, symbol: 'FIX', model_version: 'momentum-v2.0.0', state, score: 70, opportunity: 0,
        detected_at: detectedAt, detected_price: price,
        snapshot: JSON.stringify({schema: 1, address, pair: pairAddress, priceUsd: price}),
        assessment: JSON.stringify({modelVersion: 'momentum-v2.0.0', state, score: 70, summary: `${state} · score 70/100. Recorded before the upgrade.`}),
      });
      const outcome = (signalId, horizon, dueAt, deadlineAt, status = 'pending', observed = {}) => insert(sqlite, 'goldmine_outcomes', {
        signal_id: signalId, horizon, due_at: dueAt, deadline_at: deadlineAt, status, ...observed,
      });
      // Detected 16 minutes ago: its 15m outcome is due now and still inside its window.
      const recent = now - 16 * minute;
      signal(goldmine.recent, addresses.tokenA, addresses.pairA, 'BUILDING', recent, 0.5);
      outcome(goldmine.recent, '15m', recent + 15 * minute, recent + 20 * minute);
      outcome(goldmine.recent, '1h', recent + hour, recent + hour + 15 * minute);
      // Detected a day ago: settled outcomes, one missed, one delisted.
      const old = now - 25 * hour;
      signal(goldmine.old, addresses.tokenB, addresses.pairB, 'EARLY', old, 2);
      outcome(goldmine.old, '15m', old + 15 * minute, old + 20 * minute, 'observed', {observed_at: old + 16 * minute, price: 2.5, liquidity: 80000.5});
      outcome(goldmine.old, '1h', old + hour, old + hour + 15 * minute, 'missed');
      outcome(goldmine.old, '6h', old + 6 * hour, old + 7 * hour, 'unavailable', {observed_at: old + 6 * hour});
    },

    async verify(sqlite) {
      const goldmineRoute = await import('../../app/api/goldmine/route.ts');
      const health = await import('../../app/api/health/route.ts');
      const {pair} = await import('../helpers/goldmine-fixtures.mjs');
      const d1 = createD1(sqlite);
      runtime.env.DB = d1;
      signIn(userB);
      assert.equal((await body(await health.GET())).schema, 'compatible');

      // Recorded signals and settled outcomes are served unchanged, with returns from the detection price.
      const before = await body(await goldmineRoute.GET());
      const old = before.signals.find(signal => signal.id === goldmine.old);
      assert.deepEqual(old.outcomes.map(outcome => [outcome.horizon, outcome.status, outcome.price, outcome.returnPct]),
        [['15m', 'observed', 2.5, 25], ['1h', 'missed', null, null], ['6h', 'unavailable', null, null]]);
      assert.equal(old.assessment.summary, 'EARLY · score 70/100. Recorded before the upgrade.');
      // Signals keep the model version that scored them; statistics never mix versions, so these v2.0.0
      // rows are listed but not counted in the current version's statistics.
      assert.deepEqual([old.modelVersion, before.stats], ['momentum-v2.0.0', []]);

      // A scan settles the due outcome of the upgraded signal and records new ones next to it. A minute
      // later, so provider responses cached by earlier fixtures' checks have expired.
      mock.timers.setTime(Date.now() + 60000);
      const now = Date.now();
      installFetch(url => {
        if (url.includes('/token-profiles/')) return Response.json([{chainId: 'solana', tokenAddress: addresses.tokenA}]);
        if (url.includes('/token-boosts/')) return Response.json([]);
        if (url.includes('/tokens/v1/solana/')) return Response.json([pair({pairCreatedAt: now - 48 * 3600000})]);
        return Response.json({pairs: [{chainId: 'solana', pairAddress: addresses.pairA, baseToken: {address: addresses.tokenA}, priceUsd: '0.55', liquidity: {usd: 90000}}]});
      });
      const scan = await body(await goldmineRoute.POST(jsonRequest('/api/goldmine', {method: 'POST', body: {}})));
      assert.deepEqual([scan.status, scan.tracking.outcomes.observed, scan.tracking.newSignals], ['checked', 1, 1]);
      assert.deepEqual(d1.rows('SELECT horizon, status, price FROM goldmine_outcomes WHERE signal_id = ? ORDER BY due_at', goldmine.recent),
        [{horizon: '15m', status: 'observed', price: 0.55}, {horizon: '1h', status: 'pending', price: null}]);
      assert.equal(d1.rows('SELECT COUNT(*) AS n FROM goldmine_signals')[0].n, 3);
      assert.deepEqual(d1.rows('SELECT id FROM research_locks WHERE id = ?', 'goldmine:scan'), []);
    },
  },
};
