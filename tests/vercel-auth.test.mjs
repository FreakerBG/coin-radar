// Regression coverage for the Vercel preview auth guard (app/chatgpt-auth.ts). Sites' private
// front door is what actually enforces Sign in with ChatGPT before oai-authenticated-user-*
// headers exist; the isolated Vercel build (next.config.ts, npm run build:vercel) has no such
// front door and is publicly reachable, so these headers must never be trusted there, however
// they are forged. Public market data must keep working regardless.
import assert from 'node:assert/strict';
import {afterEach, beforeEach, describe, test} from 'node:test';
import {addresses, body, createD1, installFetch, jsonRequest, offlineFetch, runtime, signIn, signOut, startClock} from './helpers/harness.mjs';

const {getChatGPTUser, requireChatGPTUser} = await import('../app/chatgpt-auth.ts');
const {GET: portfolioGet} = await import('../app/api/portfolio/route.ts');
const {GET: socialGet} = await import('../app/api/social/route.ts');
const {GET: marketGet} = await import('../app/api/market/route.ts');

let d1;
beforeEach(() => {
  startClock();
  d1 = createD1();
  runtime.env.DB = d1;
  installFetch(offlineFetch);
  signIn('attacker');
});

afterEach(() => {
  delete process.env.VERCEL;
  signOut();
});

describe('off Sites (Vercel), forged oai-authenticated-user-* headers grant nothing', () => {
  test('getChatGPTUser trusts the headers by default (Sites and local dev)', async () => {
    assert.deepEqual(await getChatGPTUser(), {userId: 'attacker', displayName: 'attacker@example.test', email: 'attacker@example.test', fullName: null});
  });

  test('getChatGPTUser ignores the same headers when process.env.VERCEL is set', async () => {
    process.env.VERCEL = '1';
    assert.equal(await getChatGPTUser(), null);
  });

  test('requireChatGPTUser redirects to sign-in instead of trusting forged headers', async () => {
    process.env.VERCEL = '1';
    await assert.rejects(() => requireChatGPTUser('/'), /Unexpected redirect to \/signin-with-chatgpt/);
  });

  test('a storage-backed, authenticated route fails closed (401) without touching storage', async () => {
    process.env.VERCEL = '1';
    const response = await portfolioGet();
    assert.equal(response.status, 401);
    assert.equal((await body(response)).error, 'Sign in to load your research account.');
    assert.equal(d1.queries.length, 0, 'no storage query ran for the forged identity');
  });

  test('another storage-backed route (social) also fails closed on Vercel', async () => {
    process.env.VERCEL = '1';
    const response = await socialGet(jsonRequest('/api/social?address=' + addresses.tokenA));
    assert.equal(response.status, 401);
    assert.equal(d1.queries.length, 0);
  });

  test('public market data keeps working on Vercel with the same forged headers', async () => {
    process.env.VERCEL = '1';
    installFetch(() => Response.json([{chainId: 'solana', pairAddress: addresses.pairA, baseToken: {address: addresses.tokenA, name: 'Fixture', symbol: 'FIX'}, priceUsd: '1', liquidity: {usd: 50000}, volume: {h24: 200000}, txns: {h1: {buys: 30, sells: 10}}, priceChange: {h1: 5, h24: 1}}]));
    const response = await marketGet(jsonRequest('/api/market?addresses=' + addresses.tokenA));
    assert.equal(response.status, 200);
  });
});
