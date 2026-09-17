// Upgrade-path coverage: one entry per migration in drizzle/meta/_journal.json, in order (enforced by
// upgrade.test.mjs). seed(sqlite) writes representative rows that are valid right after that migration;
// verify(sqlite) proves the real routes still serve those rows correctly at the current schema.
// A migration that intentionally rewrites existing data lists what it changes in `changes`
// ({"table" or "table.column": reason}); any other change to pre-existing data fails the upgrade test.
import assert from 'node:assert/strict';
import {addresses, body, createD1, installFetch, jsonRequest, runtime, signIn} from '../helpers/harness.mjs';

const userA = 'user-a', userB = 'user-b';
const ids = {
  aOpen: '11111111-1111-4111-8111-111111111111',
  aClosed: '22222222-2222-4222-8222-222222222222',
  bOpen: '33333333-3333-4333-8333-333333333333',
};
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
};
