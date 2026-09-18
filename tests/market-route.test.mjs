// GET /api/market discovery (no query): latest profiles and top boosts, up to 30 Solana tokens, one
// pool per token. Pins the behavior shared with /api/goldmine through lib/market.ts discoverSolanaPairs.
import assert from 'node:assert/strict';
import {beforeEach, test} from 'node:test';
import {addresses, body, failures, installFetch, jsonRequest, startClock} from './helpers/harness.mjs';

const {GET} = await import('../app/api/market/route.ts');

let calls, feeds;
const pool = (token, pairAddress, liquidity, extra = {}) => ({
  chainId: 'solana', pairAddress, baseToken: {address: token, name: 'Fixture', symbol: 'FIX'}, priceUsd: '1',
  liquidity: {usd: liquidity}, volume: {h24: 200000}, txns: {h1: {buys: 30, sells: 10}}, priceChange: {h1: 5, h24: 1}, ...extra,
});
const discover = () => GET(jsonRequest('/api/market'));
// Numbered base58 addresses (no 0, O, I or l) for the 30-token cap.
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const numbered = index => 'Tkn' + BASE58[Math.floor(index / BASE58.length)] + BASE58[index % BASE58.length] + 'A'.repeat(39);

function resetFeeds() {
  feeds = {
    profiles: () => Response.json([
      {chainId: 'solana', tokenAddress: addresses.tokenA}, {chainId: 'ethereum', tokenAddress: addresses.tokenC},
      {chainId: 'solana', tokenAddress: 'not-an-address'}, {chainId: 'solana', tokenAddress: addresses.tokenB},
    ]),
    boosts: () => Response.json([{chainId: 'solana', tokenAddress: addresses.tokenB}, {chainId: 'solana', tokenAddress: addresses.tokenA}]),
    pairs: () => Response.json([
      pool(addresses.tokenA, addresses.pairA, 50000), pool(addresses.tokenA, addresses.pairA2, 120000),
      pool(addresses.tokenB, addresses.pairB, 30000), {...pool(addresses.tokenC, addresses.pairC, 900000), chainId: 'ethereum'},
    ]),
  };
}

beforeEach(() => {
  startClock();
  failures.length = 0;
  resetFeeds();
  calls = installFetch(url => {
    if (url.includes('/token-profiles/')) return feeds.profiles();
    if (url.includes('/token-boosts/')) return feeds.boosts();
    if (url.includes('/tokens/v1/solana/')) return feeds.pairs(url);
    throw new Error('Unexpected request ' + url);
  });
});

test('discovers Solana tokens from both feeds, marks boosted ones and keeps the deepest pool', async () => {
  const response = await discover();
  assert.equal(response.headers.get('cache-control'), 'private, max-age=30');
  const data = await body(response);
  assert.equal(calls.at(-1).url, `https://api.dexscreener.com/tokens/v1/solana/${addresses.tokenA},${addresses.tokenB}`);
  assert.deepEqual(data.coins.map(coin => [coin.address, coin.pair, coin.boosted]), [[addresses.tokenA, addresses.pairA2, true], [addresses.tokenB, addresses.pairB, true]]);
  assert.deepEqual([data.warnings, data.source, data.cacheSeconds], [[], 'DEX Screener', 60]);
});

test('caps discovery at 30 distinct tokens in feed order', async () => {
  const tokens = Array.from({length: 35}, (_, index) => numbered(index));
  feeds.profiles = () => Response.json([...tokens, tokens[0]].map(tokenAddress => ({chainId: 'solana', tokenAddress})));
  feeds.boosts = () => Response.json([]);
  feeds.pairs = () => Response.json([]);
  await discover();
  assert.equal(calls.at(-1).url, 'https://api.dexscreener.com/tokens/v1/solana/' + tokens.slice(0, 30).join(','));
});

test('one unavailable feed reduces coverage with a warning', async () => {
  feeds.boosts = () => new Response('down', {status: 503});
  const data = await body(await discover());
  assert.deepEqual(data.warnings, ['One discovery feed is unavailable. Coverage is reduced.']);
  assert.deepEqual(data.coins.map(coin => [coin.address, coin.boosted]), [[addresses.tokenA, false], [addresses.tokenB, false]]);
});

test('no Solana tokens or an unexpected pools response is a provider failure', async () => {
  for (const setup of [
    () => { feeds.profiles = () => Response.json([{chainId: 'ethereum', tokenAddress: addresses.tokenC}]); feeds.boosts = () => new Response('down', {status: 503}); },
    () => { feeds.pairs = () => Response.json({pairs: []}); },
  ]) {
    startClock();
    resetFeeds();
    setup();
    const response = await discover();
    assert.deepEqual([response.status, (await body(response)).error], [502, 'Market provider unavailable. Retry shortly; no trading signals are being generated.']);
  }
  assert.deepEqual(failures.map(failure => [failure.route, failure.error.message]), [
    ['market', 'Discovery feeds returned no Solana tokens.'], ['market', 'Unexpected provider response'],
  ]);
});
