// Manual trading handoff: outbound link construction (lib/trade-links.ts), the exact mint/pool handoff and
// the manual-record rules (lib/trade-handoff.ts), and the read-only Goldmine refresh (lib/goldmine/live-refresh.ts).
// Pure functions only: no browser, no network, no storage.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {addresses} from './helpers/harness.mjs';

const links = await import('../lib/trade-links.ts');
const handoff = await import('../lib/trade-handoff.ts');
const refresh = await import('../lib/goldmine/live-refresh.ts');

// WIF, the token Phantom's own documentation uses in both examples below.
const WIF = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
const MINT = addresses.tokenA, POOL = addresses.pairA, OTHER_POOL = addresses.pairA2;

// Every way a stored or user-supplied value could try to become something other than one address segment.
const INVALID = [
  '', ' ', 'short', '0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl', `${MINT} `, ` ${MINT}`, `${MINT}/../x`, `${MINT}?amount=5`,
  `${MINT}#x`, `${MINT}&sell=x`, 'https://evil.example/aaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'A'.repeat(45), 'A'.repeat(31),
  `${MINT.slice(0, 20)}\n${MINT.slice(20)}`, null, undefined, 42, {toString: () => MINT},
];

describe('outbound trading links', () => {
  test('the Phantom token page matches the documented https://phantom.com/tokens/<chain>/<token_address> format', () => {
    assert.equal(links.phantomTokenUrl(WIF), `https://phantom.com/tokens/solana/${WIF}`);
  });

  test("the Phantom swap link is byte-for-byte Phantom's documented WIF example", () => {
    // https://docs.phantom.com/phantom-deeplinks/other-methods/swap, "Swap SOL to WIF".
    assert.equal(links.phantomSwapUrl(WIF), 'https://phantom.app/ul/v1/swap/?buy=solana%3A101%2Faddress%3AEKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm&sell=');
  });

  test('the Phantom swap link prefills only the token to buy: no amount, no other parameter', () => {
    const url = new URL(links.phantomSwapUrl(MINT));
    assert.deepEqual([...url.searchParams.keys()], ['buy', 'sell']);
    assert.equal(url.searchParams.get('buy'), `solana:101/address:${MINT}`);
    assert.equal(url.searchParams.get('sell'), '', 'empty sell is documented as SOL');
    assert.equal(url.origin + url.pathname, 'https://phantom.app/ul/v1/swap/');
  });

  test('the Axiom token link and the documented search fallback', () => {
    assert.equal(links.axiomTokenUrl(MINT), `https://axiom.trade/meme/${MINT}`);
    assert.equal(links.AXIOM_SEARCH_URL, 'https://axiom.trade/pulse');
    assert.equal(links.dexscreenerPoolUrl(POOL), `https://dexscreener.com/solana/${POOL}`);
  });

  test('no builder ever returns a link for an invalid address', () => {
    for (const value of INVALID) {
      assert.equal(links.isSolanaAddress(value), false, String(value));
      for (const build of [links.axiomTokenUrl, links.phantomTokenUrl, links.phantomSwapUrl, links.dexscreenerPoolUrl]) {
        assert.equal(build(value), null, `${build.name}(${JSON.stringify(value)})`);
      }
      assert.equal(links.tradeLinks(value, POOL, true), null);
    }
  });

  test('every link is https on the expected host, whatever the valid input', () => {
    const all = links.tradeLinks(MINT, POOL, true);
    const hosts = {axiom: 'axiom.trade', axiomSearch: 'axiom.trade', phantomToken: 'phantom.com', phantomSwap: 'phantom.app', pool: 'dexscreener.com'};
    for (const [key, host] of Object.entries(hosts)) {
      const url = new URL(all[key]);
      assert.deepEqual([url.protocol, url.hostname], ['https:', host], key);
    }
  });

  test('desktop gets no swap deeplink; an invalid pool drops only the pool link', () => {
    assert.equal(links.tradeLinks(MINT, POOL, false).phantomSwap, null);
    assert.ok(links.tradeLinks(MINT, POOL, false).phantomToken, 'desktop keeps the token page');
    const badPool = links.tradeLinks(MINT, 'not-a-pool', true);
    assert.equal(badPool.pool, null);
    assert.ok(badPool.axiom && badPool.phantomToken && badPool.phantomSwap);
  });

  test('only phone and tablet user agents count as mobile', () => {
    const cases = [
      ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', 0, true],
      ['Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36', 5, true],
      ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', 5, true], // iPadOS
      ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', 0, false],
      ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36', 10, false],
      ['', 0, false],
    ];
    for (const [ua, touch, expected] of cases) assert.equal(links.isMobileUserAgent(ua, touch), expected, ua);
  });
});

describe('exact-coin handoff', () => {
  const signal = {address: MINT, pair: POOL, symbol: '  FIXA  ', detectedAt: '2026-09-29T10:00:00.000Z'};

  test('a Goldmine signal becomes a target for exactly its mint and pool, with no price or liquidity', () => {
    assert.deepEqual(handoff.goldmineTarget(signal), {address: MINT, pair: POOL, symbol: 'FIXA', source: 'goldmine', liquidity: null, detectedAt: '2026-09-29T10:00:00.000Z'});
    assert.equal(handoff.goldmineTarget({...signal, detectedAt: Date.parse(signal.detectedAt)}).detectedAt, signal.detectedAt);
    assert.equal('detectedAt' in handoff.goldmineTarget({...signal, detectedAt: 'not a date'}), false);
  });

  test('an invalid mint or pool produces no target at all', () => {
    for (const value of INVALID) {
      assert.equal(handoff.goldmineTarget({...signal, address: value}), null);
      assert.equal(handoff.goldmineTarget({...signal, pair: value}), null);
    }
  });

  test('a Discover selection keeps its snapshot liquidity; an invalid one is dropped', () => {
    const coin = {address: MINT, pair: POOL, symbol: 'FIXA', liquidity: 150000};
    assert.deepEqual(handoff.marketTarget(coin), {address: MINT, pair: POOL, symbol: 'FIXA', source: 'market', liquidity: 150000});
    assert.equal(handoff.marketTarget(null), null);
    assert.equal(handoff.marketTarget({...coin, pair: 'x'}), null);
  });

  test('the same mint on another pool is a different target', () => {
    const a = handoff.goldmineTarget(signal), b = handoff.goldmineTarget({...signal, pair: OTHER_POOL});
    assert.notEqual(handoff.targetKey(a), handoff.targetKey(b));
    assert.equal(handoff.targetKey(null), '');
  });

  test('evidence counts only for the same mint and pool, and only while fresh', () => {
    const target = handoff.goldmineTarget(signal);
    const now = 1_000_000;
    const fresh = {address: MINT, pair: POOL, liquidity: 5};
    assert.equal(handoff.evidenceFor(target, fresh, now - 1000, now), fresh);
    assert.equal(handoff.evidenceFor(target, {...fresh, pair: OTHER_POOL}, now - 1000, now), null, 'sibling pool');
    assert.equal(handoff.evidenceFor(target, {...fresh, address: addresses.tokenB}, now - 1000, now), null, 'other mint');
    assert.equal(handoff.evidenceFor(target, fresh, now - handoff.EVIDENCE_FRESH_MS, now), null, 'stale');
    assert.equal(handoff.evidenceFor(null, fresh, now, now), null);
  });
});

describe('manual-record semantics', () => {
  const target = handoff.goldmineTarget({address: MINT, pair: POOL, symbol: 'FIXA'});
  const record = (overrides = {}) => handoff.manualPosition({id: 'id-1', target, entryPrice: '0.000123', amount: '25', entryLiquidity: null, ...overrides});

  test('a position carries exactly the handed-over mint and pool and the fill the owner typed', () => {
    assert.deepEqual(record(), {ok: true, position: {id: 'id-1', address: MINT, pair: POOL, symbol: 'FIXA', entryPrice: 0.000123, amount: 25, entryLiquidity: null}});
    assert.equal(record({entryPrice: '1e-7'}).position.entryPrice, 1e-7);
  });

  test('without an actual fill price and amount there is no position', () => {
    for (const entryPrice of ['', ' ', '0', '-1', 'abc', '0x10', '1e999', 'Infinity', 'NaN', '1,5', '1000000001']) {
      const result = record({entryPrice});
      assert.equal(result.ok, false, `price ${JSON.stringify(entryPrice)}`);
      assert.match(result.reason, /fill price/);
    }
    for (const amount of ['', '0', '0.009', '-5', 'ten', '100000001']) {
      const result = record({amount});
      assert.equal(result.ok, false, `amount ${JSON.stringify(amount)}`);
      assert.match(result.reason, /amount spent/);
    }
  });

  test('no target, or a target whose addresses do not validate, records nothing', () => {
    assert.deepEqual(record({target: null}), {ok: false, reason: 'Select a coin first.'});
    assert.equal(record({target: {...target, pair: 'bad'}}).ok, false);
  });

  test('a liquidity baseline is kept only when it is a real non-negative number', () => {
    assert.equal(record({entryLiquidity: 42000}).position.entryLiquidity, 42000);
    for (const entryLiquidity of [NaN, -1, Infinity, undefined]) assert.equal(record({entryLiquidity}).position.entryLiquidity, null);
  });
});

describe('read-only Goldmine refresh', () => {
  test('fetchTracking only ever issues GET /api/goldmine', async () => {
    const calls = [];
    const fake = async (url, init) => { calls.push({url, method: init?.method ?? 'GET', body: init?.body}); return Response.json({signals: []}); };
    await refresh.fetchTracking(fake);
    await refresh.fetchTracking(fake);
    assert.deepEqual(calls, [{url: '/api/goldmine', method: 'GET', body: undefined}, {url: '/api/goldmine', method: 'GET', body: undefined}]);
  });

  test('fetchTracking reports errors instead of throwing', async () => {
    assert.deepEqual(await refresh.fetchTracking(async () => Response.json({error: 'Signal storage unavailable.'}, {status: 503})), {error: 'Signal storage unavailable.'});
    assert.deepEqual(await refresh.fetchTracking(async () => new Response('nope', {status: 500})), {error: 'Cannot reach Goldmine. Check your connection and retry.'});
    assert.deepEqual(await refresh.fetchTracking(async () => { throw new TypeError('offline'); }), {error: 'Cannot reach Goldmine. Check your connection and retry.'});
  });

  test('a refresh is due only when visible and an interval has passed since the last attempt', () => {
    const now = 10 * refresh.TRACKING_REFRESH_MS;
    assert.equal(refresh.refreshDue(null, now, true), true);
    assert.equal(refresh.refreshDue(now - refresh.TRACKING_REFRESH_MS, now, true), true);
    assert.equal(refresh.refreshDue(now - refresh.TRACKING_REFRESH_MS + 1, now, true), false);
    assert.equal(refresh.refreshDue(null, now, false), false, 'hidden tabs never poll');
    assert.ok(refresh.TRACKING_REFRESH_MS >= 60000, 'never faster than once a minute');
  });

  test('the first read is a silent baseline; each new opportunity is reported exactly once', () => {
    const s = (id, opportunity = true) => ({id, opportunity});
    let state = refresh.trackNewOpportunities(null, [s('a'), s('b'), s('r', false)]);
    assert.deepEqual(state.fresh, [], 'opening the page marks nothing as new');
    state = refresh.trackNewOpportunities(state.seen, [s('c'), s('a'), s('b'), s('x', false)]);
    assert.deepEqual(state.fresh, ['c'], 'only the new opportunity, never a non-opportunity signal');
    state = refresh.trackNewOpportunities(state.seen, [s('c'), s('a')]);
    assert.deepEqual(state.fresh, [], 'the same signal is not announced twice');
    state = refresh.trackNewOpportunities(state.seen, [s('b'), s('d')]);
    assert.deepEqual(state.fresh, ['d'], 'a signal that dropped out of the window and returns is not new');
  });

  test('the announcement never frames a signal as a trade instruction', () => {
    assert.equal(refresh.newOpportunitiesAnnouncement(0), '');
    assert.match(refresh.newOpportunitiesAnnouncement(1), /^1 newly recorded opportunity .*not trade instructions\.$/);
    assert.match(refresh.newOpportunitiesAnnouncement(3), /^3 newly recorded opportunities /);
  });
});
