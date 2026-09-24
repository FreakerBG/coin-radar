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
const {SESSION_COOKIE, createOwnerSession, hashOwnerPassword} = await import('../app/owner-auth.ts');
const {POST: loginPost} = await import('../app/api/auth/login/route.ts');
const {POST: logoutPost} = await import('../app/api/auth/logout/route.ts');

const ORIGINAL_AUTH_SECRET = process.env.AUTH_SECRET;
const ORIGINAL_OWNER_PASSWORD_HASH = process.env.OWNER_PASSWORD_HASH;
// The hash the supported operator workflow produces. `npm run owner:hash` calls this exact
// function, so these tests exercise the credential an operator would really configure - not a
// lookalike built to match the verifier, which is how the salt-encoding mismatch went unnoticed.
const ownerPasswordHash = password => hashOwnerPassword(password);

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
  if (ORIGINAL_AUTH_SECRET === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = ORIGINAL_AUTH_SECRET;
  if (ORIGINAL_OWNER_PASSWORD_HASH === undefined) delete process.env.OWNER_PASSWORD_HASH;
  else process.env.OWNER_PASSWORD_HASH = ORIGINAL_OWNER_PASSWORD_HASH;
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
    // Off Sites the redirect goes to /login: /signin-with-chatgpt is served by the Sites front door,
    // outside this application, so sending a Vercel visitor there 404s. See tests/owner-login-flow.test.mjs.
    await assert.rejects(() => requireChatGPTUser('/'), /Unexpected redirect to \/login/);
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

describe('off Sites (Vercel), identity instead comes only from the owner-auth session cookie', () => {
  test('a valid owner session cookie resolves to the fixed synthetic "owner" identity', async () => {
    process.env.VERCEL = '1';
    process.env.AUTH_SECRET = 'test-secret';
    const session = createOwnerSession();
    runtime.headers = new Headers({cookie: `${SESSION_COOKIE}=${session}`});
    assert.deepEqual(await getChatGPTUser(), {userId: 'owner', displayName: 'Owner', email: 'owner@vercel.local', fullName: null});
  });

  test('a storage-backed route succeeds once the owner cookie is valid', async () => {
    process.env.VERCEL = '1';
    process.env.AUTH_SECRET = 'test-secret';
    runtime.headers = new Headers({cookie: `${SESSION_COOKIE}=${createOwnerSession()}`});
    const response = await portfolioGet();
    assert.equal(response.status, 200);
  });

  test('no cookie at all still fails closed (401), even with AUTH_SECRET configured', async () => {
    process.env.VERCEL = '1';
    process.env.AUTH_SECRET = 'test-secret';
    runtime.headers = new Headers();
    assert.equal(await getChatGPTUser(), null);
    assert.equal((await portfolioGet()).status, 401);
  });

  test('a tampered cookie value is rejected', async () => {
    process.env.VERCEL = '1';
    process.env.AUTH_SECRET = 'test-secret';
    const session = createOwnerSession();
    runtime.headers = new Headers({cookie: `${SESSION_COOKIE}=${session}tampered`});
    assert.equal(await getChatGPTUser(), null);
  });

  test('without AUTH_SECRET configured, no cookie can ever verify, however it was minted', async () => {
    process.env.VERCEL = '1';
    process.env.AUTH_SECRET = 'test-secret';
    const session = createOwnerSession();
    delete process.env.AUTH_SECRET;
    runtime.headers = new Headers({cookie: `${SESSION_COOKIE}=${session}`});
    assert.equal(await getChatGPTUser(), null);
  });

  test('the owner cookie is never read on Sites (VERCEL unset): a same identity cookie there is simply ignored', async () => {
    process.env.AUTH_SECRET = 'test-secret';
    const session = createOwnerSession();
    runtime.headers = new Headers({
      cookie: `${SESSION_COOKIE}=${session}`,
      'oai-authenticated-user-id': 'sites-user',
      'oai-authenticated-user-email': 'sites-user@example.test',
    });
    assert.deepEqual(await getChatGPTUser(), {userId: 'sites-user', displayName: 'sites-user@example.test', email: 'sites-user@example.test', fullName: null});
  });
});

describe('POST /api/auth/login and /api/auth/logout (owner-secret sign-in)', () => {
  beforeEach(() => {
    process.env.VERCEL = '1';
    process.env.AUTH_SECRET = 'test-secret';
    process.env.OWNER_PASSWORD_HASH = ownerPasswordHash('correct password');
  });

  test('same-origin is required, before the password is even checked', async () => {
    const response = await loginPost(jsonRequest('/api/auth/login', {method: 'POST', body: {password: 'correct password'}, origin: 'https://attacker.test'}));
    assert.equal(response.status, 403);
  });

  test('the correct password sets a working, httpOnly, secure, SameSite=Strict session cookie', async () => {
    const response = await loginPost(jsonRequest('/api/auth/login', {method: 'POST', body: {password: 'correct password'}}));
    assert.equal(response.status, 200);
    const setCookie = response.headers.get('set-cookie');
    assert.match(setCookie, new RegExp(`^${SESSION_COOKIE}=`));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Strict/);

    const cookieValue = setCookie.split(';')[0].slice(SESSION_COOKIE.length + 1);
    runtime.headers = new Headers({cookie: `${SESSION_COOKIE}=${cookieValue}`});
    assert.equal(await getChatGPTUser().then(u => u?.userId), 'owner');
  });

  test('a wrong password is rejected and sets no cookie', async () => {
    const response = await loginPost(jsonRequest('/api/auth/login', {method: 'POST', body: {password: 'wrong password'}}));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('set-cookie'), null);
  });

  test('an empty or missing password is a 400, never reaching the password check', async () => {
    assert.equal((await loginPost(jsonRequest('/api/auth/login', {method: 'POST', body: {password: ''}}))).status, 400);
    assert.equal((await loginPost(jsonRequest('/api/auth/login', {method: 'POST', body: {}}))).status, 400);
  });

  test('login fails closed (503) if AUTH_SECRET is unset, even with the correct password', async () => {
    delete process.env.AUTH_SECRET;
    const response = await loginPost(jsonRequest('/api/auth/login', {method: 'POST', body: {password: 'correct password'}}));
    assert.equal(response.status, 503);
  });

  test('logout requires same-origin and clears the cookie', async () => {
    assert.equal((await logoutPost(jsonRequest('/api/auth/logout', {method: 'POST', origin: 'https://attacker.test'}))).status, 403);
    const response = await logoutPost(jsonRequest('/api/auth/logout', {method: 'POST'}));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  });
});
