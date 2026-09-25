// The owner sign-in journey on the Vercel+Turso deployment, end to end through the real route
// handlers: generate a credential the documented way, sign in with it, reach an authenticated API,
// find the sign-in page as an anonymous visitor, and sign out.
//
// This file exists because of a gap rather than a feature. app/owner-auth.ts and
// docs/deployment-runbook.md documented a generator whose output verifyOwnerPassword() could never
// accept, and every existing test still passed: they each built their own hash to match whichever
// side they were testing, so nothing ever crossed the boundary between "what the operator is told to
// run" and "what the login route accepts". Every test below crosses it.
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { body, createD1, installFetch, jsonRequest, offlineFetch, runtime, signOut, startClock } from './helpers/harness.mjs';

const { getChatGPTUser, requireChatGPTUser, chatGPTSignInPath } = await import('../app/chatgpt-auth.ts');
const { SESSION_COOKIE, createOwnerSession, hashOwnerPassword } = await import('../app/owner-auth.ts');
const { GET: portfolioGet } = await import('../app/api/portfolio/route.ts');
const { POST: loginPost } = await import('../app/api/auth/login/route.ts');
const { POST: logoutPost } = await import('../app/api/auth/logout/route.ts');
const { GET: sessionGet } = await import('../app/api/auth/session/route.ts');

const ORIGINAL_AUTH_SECRET = process.env.AUTH_SECRET;
const ORIGINAL_OWNER_PASSWORD_HASH = process.env.OWNER_PASSWORD_HASH;

beforeEach(() => {
  startClock();
  runtime.env.DB = createD1();
  installFetch(offlineFetch);
  runtime.headers = new Headers();
  process.env.VERCEL = '1';
  process.env.AUTH_SECRET = 'test-secret';
});

afterEach(() => {
  delete process.env.VERCEL;
  signOut();
  if (ORIGINAL_AUTH_SECRET === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = ORIGINAL_AUTH_SECRET;
  if (ORIGINAL_OWNER_PASSWORD_HASH === undefined) delete process.env.OWNER_PASSWORD_HASH;
  else process.env.OWNER_PASSWORD_HASH = ORIGINAL_OWNER_PASSWORD_HASH;
});

function login(password) {
  return loginPost(jsonRequest('/api/auth/login', { method: 'POST', body: { password } }));
}

function cookieFrom(response) {
  const setCookie = response.headers.get('set-cookie');
  return setCookie.split(';')[0].slice(SESSION_COOKIE.length + 1);
}

describe('the documented operator workflow authenticates through the real login route', () => {
  test('a hash from `npm run owner:hash` signs in, and the cookie it issues works on an authenticated API', async () => {
    // hashOwnerPassword() is exactly what scripts/owner-password-hash.mjs prints.
    const password = 'a well chosen owner password';
    process.env.OWNER_PASSWORD_HASH = hashOwnerPassword(password);

    const response = await login(password);
    assert.equal(response.status, 200, 'the documented setup must be able to sign in');

    runtime.headers = new Headers({ cookie: `${SESSION_COOKIE}=${cookieFrom(response)}` });
    assert.equal(await getChatGPTUser().then(u => u?.userId), 'owner');
    assert.equal((await portfolioGet()).status, 200, 'the issued cookie must work on a storage-backed route');
  });

  test('neither reading of the old ambiguous "<saltHex>:<hashHex>" shape is accepted any more', async () => {
    const password = 'a well chosen owner password';
    const saltHex = randomBytes(16).toString('hex');
    const legacy = {
      'salted with the hex text (what the old docs generated)': `${saltHex}:${scryptSync(password, saltHex, 64).toString('hex')}`,
      'salted with the bytes (what the old verifier accepted)': `${saltHex}:${scryptSync(password, Buffer.from(saltHex, 'hex'), 64).toString('hex')}`,
    };
    for (const [label, hash] of Object.entries(legacy)) {
      process.env.OWNER_PASSWORD_HASH = hash;
      const response = await login(password);
      assert.equal(response.status, 401, label);
      assert.equal(response.headers.get('set-cookie'), null, label);
    }
  });

  test('a truncated OWNER_PASSWORD_HASH rejects every password rather than accepting roughly 1 in 256', async () => {
    // Buffer.from('ff', 'hex') is one byte. The previous implementation derived a one-byte key and
    // compared that, so arbitrary passwords got in at chance. Measured here rather than asserted.
    process.env.OWNER_PASSWORD_HASH = 'aa:ff';
    let accepted = 0;
    for (let i = 0; i < 300; i++) if ((await login('guess-' + i)).status === 200) accepted++;
    assert.equal(accepted, 0);
  });

  test('an over-long password is rejected without a cookie and without hashing it', async () => {
    process.env.OWNER_PASSWORD_HASH = hashOwnerPassword('a well chosen owner password');
    const response = await login('x'.repeat(100_000));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('set-cookie'), null);
  });

  test('missing configuration is indistinguishable from a wrong password to the caller', async () => {
    const password = 'a well chosen owner password';
    delete process.env.OWNER_PASSWORD_HASH;
    const unconfigured = await login(password);
    process.env.OWNER_PASSWORD_HASH = hashOwnerPassword(password);
    const wrong = await login('not it');

    assert.equal(unconfigured.status, 401);
    assert.equal(wrong.status, 401);
    assert.deepEqual(await body(unconfigured), await body(wrong), 'neither response may reveal which secret is unset');
  });
});

describe('the whole journey: anonymous -> sign in -> reload -> sign out', () => {
  const password = 'a well chosen owner password';
  beforeEach(() => { process.env.OWNER_PASSWORD_HASH = hashOwnerPassword(password); });

  test('an anonymous visitor is refused, is told where to sign in, signs in, stays signed in, then signs out', async () => {
    // 1. Anonymous: authenticated routes refuse, and the session endpoint names the sign-in page.
    assert.equal((await portfolioGet()).status, 401);
    const anonymous = await body(await sessionGet(jsonRequest('/api/auth/session?return_to=%2F')));
    assert.equal(anonymous.signedIn, false);
    assert.match(anonymous.signInPath, /^\/login\?/);

    // 2. Sign in at the page that was named.
    const response = await login(password);
    assert.equal(response.status, 200);
    const cookie = cookieFrom(response);

    // 3. A later request carrying that cookie - a reload, or a direct hit on a protected route.
    runtime.headers = new Headers({ cookie: `${SESSION_COOKIE}=${cookie}` });
    assert.equal((await portfolioGet()).status, 200);
    assert.deepEqual(await body(await sessionGet(jsonRequest('/api/auth/session'))), { signedIn: true, signInPath: null });

    // 4. Sign out clears the cookie...
    const loggedOut = await logoutPost(jsonRequest('/api/auth/logout', { method: 'POST' }));
    assert.match(loggedOut.headers.get('set-cookie'), /Max-Age=0/);

    // 5. ...and a request without it is anonymous again.
    runtime.headers = new Headers();
    assert.equal((await portfolioGet()).status, 401);
  });

  test('rotating AUTH_SECRET revokes a cookie that is still in the browser', async () => {
    const cookie = cookieFrom(await login(password));
    runtime.headers = new Headers({ cookie: `${SESSION_COOKIE}=${cookie}` });
    assert.equal((await portfolioGet()).status, 200);

    process.env.AUTH_SECRET = 'rotated-secret';
    assert.equal((await portfolioGet()).status, 401, 'rotation is the documented revocation lever');
  });

  test('clearing OWNER_PASSWORD_HASH stops new logins but leaves an issued cookie working', async () => {
    // Stated so the runbook cannot drift back to claiming both secrets gate session verification.
    const cookie = cookieFrom(await login(password));
    delete process.env.OWNER_PASSWORD_HASH;

    assert.equal((await login(password)).status, 401, 'no new login');
    runtime.headers = new Headers({ cookie: `${SESSION_COOKIE}=${cookie}` });
    assert.equal((await portfolioGet()).status, 200, 'the existing cookie is unaffected - rotate AUTH_SECRET to revoke it');
  });

  test('every auth response is marked no-store so a cache never holds a session decision', async () => {
    const responses = [
      await login(password),
      await login('wrong'),
      await logoutPost(jsonRequest('/api/auth/logout', { method: 'POST' })),
      await sessionGet(jsonRequest('/api/auth/session')),
    ];
    for (const response of responses) assert.equal(response.headers.get('cache-control'), 'no-store');
  });
});

describe('finding the sign-in page: GET /api/auth/session', () => {
  test('a forged Sites identity header never makes the session endpoint report signed in', async () => {
    runtime.headers = new Headers({
      'oai-authenticated-user-id': 'attacker',
      'oai-authenticated-user-email': 'attacker@example.test',
      'oai-authenticated-user-full-name': 'Attacker',
    });
    assert.equal((await body(await sessionGet(jsonRequest('/api/auth/session')))).signedIn, false);
  });

  test('a signed-in response discloses nothing about who is signed in', async () => {
    runtime.headers = new Headers({ cookie: `${SESSION_COOKIE}=${createOwnerSession()}` });
    const payload = await body(await sessionGet(jsonRequest('/api/auth/session')));
    assert.deepEqual(payload, { signedIn: true, signInPath: null });
    assert.equal(JSON.stringify(payload).includes('owner'), false);
  });

  test('a hostile return_to is never reflected back as a redirect target', async () => {
    for (const hostile of [
      '//evil.com',
      '/..//evil.com',            // normalizes to the protocol-relative "//evil.com"
      '/a/../..//evil.com',
      String.raw`/\evil.com`,     // WHATWG parsing treats the backslash as an authority separator
      'https://evil.com',
      '/login',                   // would bounce straight back to the sign-in page
      '/api/auth/logout',         // would undo the sign-in it had just completed
    ]) {
      const payload = await body(await sessionGet(jsonRequest('/api/auth/session?return_to=' + encodeURIComponent(hostile))));
      assert.equal(payload.signInPath, '/login?return_to=%2F', hostile);
    }
  });

  test('a legitimate in-app return_to is preserved', async () => {
    const payload = await body(await sessionGet(jsonRequest('/api/auth/session?return_to=' + encodeURIComponent('/?tab=goldmine'))));
    assert.equal(payload.signInPath, '/login?return_to=' + encodeURIComponent('/?tab=goldmine'));
  });
});

describe('chatGPTSignInPath points somewhere that exists on each platform', () => {
  test('off Sites it points at /login, the page this deployment actually serves', () => {
    assert.match(chatGPTSignInPath('/'), /^\/login\?return_to=/);
  });

  test('requireChatGPTUser redirects an anonymous Vercel visitor to /login, not to a route that 404s', async () => {
    // /signin-with-chatgpt is served by the Sites front door, outside this application. Redirecting
    // there off Sites produced a 404 and left the visitor with no way to sign in at all.
    await assert.rejects(() => requireChatGPTUser('/'), /Unexpected redirect to \/login/);
  });

  test('on Sites it is unchanged: the front door path, which Sites itself serves', () => {
    delete process.env.VERCEL;
    assert.equal(chatGPTSignInPath('/'), '/signin-with-chatgpt?return_to=%2F');
    assert.equal(chatGPTSignInPath('/..//evil.com'), '/signin-with-chatgpt?return_to=%2F');
  });

  test('a normalized protocol-relative return_to is rejected, not only a literal leading "//"', () => {
    // "/..//evil.com" has origin https://app.local, so an origin-only check lets it through, but the
    // pathname it yields is "//evil.com", which a browser resolves as https://evil.com/.
    assert.equal(chatGPTSignInPath('/..//evil.com'), '/login?return_to=%2F');
  });
});
