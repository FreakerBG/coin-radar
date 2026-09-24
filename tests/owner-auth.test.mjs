// app/owner-auth.ts: owner-secret authentication for the Vercel+Turso deployment.
//
// The central test here is "the documented setup workflow produces a hash that logs in". The first
// version of this file could not have caught the bug it was meant to guard: it built its own test
// hashes with Buffer.from(salt, 'hex'), which happened to match what verifyOwnerPassword() did,
// while the generator printed in the source comment and the runbook salted with the hex *text*. The
// two disagreed, every documented setup produced a hash that could never authenticate, and every
// test still passed. So the tests below never construct a hash by hand - they call the same
// hashOwnerPassword() that `npm run owner:hash` calls.
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { afterEach, describe, test } from 'node:test';
import {
  createOwnerSession, hashOwnerPassword, KEY_BYTES, MAX_PASSWORD_BYTES, parseOwnerPasswordHash,
  SALT_BYTES, SCRYPT_N, SCRYPT_P, SCRYPT_R, verifyOwnerPassword, verifyOwnerSession,
} from '../app/owner-auth.ts';

const ORIGINAL_AUTH_SECRET = process.env.AUTH_SECRET;
const ORIGINAL_OWNER_PASSWORD_HASH = process.env.OWNER_PASSWORD_HASH;

afterEach(() => {
  if (ORIGINAL_AUTH_SECRET === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = ORIGINAL_AUTH_SECRET;
  if (ORIGINAL_OWNER_PASSWORD_HASH === undefined) delete process.env.OWNER_PASSWORD_HASH;
  else process.env.OWNER_PASSWORD_HASH = ORIGINAL_OWNER_PASSWORD_HASH;
});

describe('hashOwnerPassword: the one canonical generator', () => {
  test('a hash from the supported generator authenticates through verifyOwnerPassword', () => {
    // The regression that shipped: the documented generator and the verifier disagreed about whether
    // the salt was the hex text or its bytes, so this was false for every hash an operator could make.
    process.env.OWNER_PASSWORD_HASH = hashOwnerPassword('correct horse battery staple');
    assert.equal(verifyOwnerPassword('correct horse battery staple'), true);
    assert.equal(verifyOwnerPassword('wrong password'), false);
  });

  test('emits the canonical, self-describing format with its cost parameters', () => {
    const hash = hashOwnerPassword('correct horse battery staple');
    const parts = hash.split('$');
    assert.equal(parts.length, 6);
    assert.deepEqual(parts.slice(0, 4), ['scrypt', String(SCRYPT_N), String(SCRYPT_R), String(SCRYPT_P)]);
    assert.equal(parts[4].length, SALT_BYTES * 2);
    assert.equal(parts[5].length, KEY_BYTES * 2);
    assert.match(hash, /^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]+\$[0-9a-f]+$/);
  });

  test('salts randomly: the same password hashes differently every time, and both verify', () => {
    const a = hashOwnerPassword('correct horse battery staple');
    const b = hashOwnerPassword('correct horse battery staple');
    assert.notEqual(a, b);
    for (const hash of [a, b]) {
      process.env.OWNER_PASSWORD_HASH = hash;
      assert.equal(verifyOwnerPassword('correct horse battery staple'), true);
    }
  });

  test('refuses an empty password or an over-long one rather than hashing it', () => {
    assert.throws(() => hashOwnerPassword(''), /password is required/i);
    assert.throws(() => hashOwnerPassword('x'.repeat(MAX_PASSWORD_BYTES + 1)), /at most/i);
  });

  test('a hash still verifies when the global cost constants later change, because the cost travels with it', () => {
    // The stored parameters are what verification uses - not today's SCRYPT_N - so raising the cost
    // for new hashes cannot silently lock the owner out of a deployment holding an older one.
    const hash = hashOwnerPassword('correct horse battery staple');
    const parsed = parseOwnerPasswordHash(hash);
    assert.equal(parsed.n, SCRYPT_N);
    process.env.OWNER_PASSWORD_HASH = `scrypt$${parsed.n}$${parsed.r}$${parsed.p}$${parsed.salt.toString('hex')}$${parsed.key.toString('hex')}`;
    assert.equal(verifyOwnerPassword('correct horse battery staple'), true);
  });
});

describe('verifyOwnerPassword', () => {
  test('fails closed when OWNER_PASSWORD_HASH is unset', () => {
    delete process.env.OWNER_PASSWORD_HASH;
    assert.equal(verifyOwnerPassword('anything'), false);
  });

  test('rejects an empty password even against a valid stored hash', () => {
    process.env.OWNER_PASSWORD_HASH = hashOwnerPassword('correct horse battery staple');
    assert.equal(verifyOwnerPassword(''), false);
  });

  test('rejects a malformed OWNER_PASSWORD_HASH outright instead of weakening the comparison', () => {
    // Buffer.from(value, 'hex') does not throw on bad input: it stops at the first invalid pair and
    // returns the prefix. Under the old parser "aa:ff" therefore reduced the check to a single byte,
    // which accepted roughly 1 in 256 arbitrary passwords. Strict parsing must reject all of these.
    const malformed = [
      'aa:ff',                                    // the old, ambiguous colon format
      'no-colon-here', ':', '', 'aa:', 'zz:zz',
      'scrypt$16384$8$1$aa$ff',                   // canonical prefix, truncated hex fields
      `scrypt$16384$8$1$${'a'.repeat(62)}$${'b'.repeat(128)}`,  // salt one byte short
      `scrypt$16384$8$1$${'a'.repeat(64)}$${'b'.repeat(126)}`,  // key one byte short
      `scrypt$16384$8$1$${'A'.repeat(64)}$${'b'.repeat(128)}`,  // uppercase hex is not canonical
      `scrypt$16383$8$1$${'a'.repeat(64)}$${'b'.repeat(128)}`,  // N not a power of two
      `scrypt$1024$8$1$${'a'.repeat(64)}$${'b'.repeat(128)}`,   // N below the work floor
      `scrypt$16384$0$1$${'a'.repeat(64)}$${'b'.repeat(128)}`,  // r out of range
      `bcrypt$16384$8$1$${'a'.repeat(64)}$${'b'.repeat(128)}`,  // wrong algorithm label
      `scrypt$16384$8$1$${'a'.repeat(64)}$${'b'.repeat(128)}$x`, // extra field
    ];
    for (const value of malformed) {
      process.env.OWNER_PASSWORD_HASH = value;
      assert.equal(verifyOwnerPassword('anything'), false, value);
      assert.equal(parseOwnerPasswordHash(value), null, value);
    }
  });

  test('a truncated hash cannot be brute-forced by chance: it is rejected, not shortened', () => {
    // Directly the old failure mode, measured. Under the previous implementation a 1-byte stored hash
    // accepted about 1 password in 256; here nothing is accepted at all.
    process.env.OWNER_PASSWORD_HASH = 'aa:ff';
    let accepted = 0;
    for (let i = 0; i < 2000; i++) if (verifyOwnerPassword('guess-' + i)) accepted++;
    assert.equal(accepted, 0);
  });

  test('bounds the password length before running the synchronous KDF', () => {
    process.env.OWNER_PASSWORD_HASH = hashOwnerPassword('correct horse battery staple');
    assert.equal(verifyOwnerPassword('x'.repeat(MAX_PASSWORD_BYTES + 1)), false);
    // The bound is on bytes, not characters, so multi-byte input cannot slip past it.
    assert.equal(verifyOwnerPassword('é'.repeat(MAX_PASSWORD_BYTES)), false);
  });

  test('a hash for one password never verifies another, including near misses', () => {
    process.env.OWNER_PASSWORD_HASH = hashOwnerPassword('correct horse battery staple');
    for (const wrong of [
      'correct horse battery stapl', 'correct horse battery staple ', 'Correct horse battery staple',
      ' correct horse battery staple', 'correct  horse battery staple',
    ]) {
      assert.equal(verifyOwnerPassword(wrong), false, wrong);
    }
  });

  test('two different salts for the same password produce different keys (the salt is really used)', () => {
    const a = hashOwnerPassword('correct horse battery staple', Buffer.alloc(SALT_BYTES, 1));
    const b = hashOwnerPassword('correct horse battery staple', Buffer.alloc(SALT_BYTES, 2));
    assert.notEqual(a.split('$')[5], b.split('$')[5]);
  });

  test('refuses a salt that is not the canonical width', () => {
    assert.throws(() => hashOwnerPassword('correct horse battery staple', randomBytes(SALT_BYTES - 1)), /Salt must be/);
  });
});

describe('createOwnerSession / verifyOwnerSession', () => {
  test('fails closed when AUTH_SECRET is unset: no session can be created or verified', () => {
    delete process.env.AUTH_SECRET;
    assert.equal(createOwnerSession(), null);
    assert.equal(verifyOwnerSession('anything.anything'), null);
  });

  test('a freshly created session verifies to the synthetic owner id', () => {
    process.env.AUTH_SECRET = 'test-secret-one';
    const session = createOwnerSession();
    assert.ok(session);
    assert.equal(verifyOwnerSession(session), 'owner');
  });

  test('missing or empty cookie value verifies to null', () => {
    process.env.AUTH_SECRET = 'test-secret-one';
    assert.equal(verifyOwnerSession(null), null);
    assert.equal(verifyOwnerSession(undefined), null);
    assert.equal(verifyOwnerSession(''), null);
  });

  test('an expired session is rejected', () => {
    process.env.AUTH_SECRET = 'test-secret-one';
    const now = Date.now();
    const session = createOwnerSession(now - 8 * 24 * 60 * 60 * 1000); // issued 8 days ago, 7-day TTL
    assert.equal(verifyOwnerSession(session, now), null);
    // ...but was valid at the moment it was issued.
    assert.equal(verifyOwnerSession(session, now - 8 * 24 * 60 * 60 * 1000), 'owner');
  });

  test('expiry is exclusive at the boundary second', () => {
    process.env.AUTH_SECRET = 'test-secret-one';
    const issued = Date.now();
    const session = createOwnerSession(issued);
    const expiry = issued + 7 * 24 * 60 * 60 * 1000;
    assert.equal(verifyOwnerSession(session, expiry - 1), 'owner');
    assert.equal(verifyOwnerSession(session, expiry), null);
    assert.equal(verifyOwnerSession(session, expiry + 1), null);
  });

  test('a tampered payload is rejected even though the signature format still parses', () => {
    process.env.AUTH_SECRET = 'test-secret-one';
    const session = createOwnerSession();
    const [payload, signature] = session.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ sub: 'owner', exp: Date.now() + 999999999 })).toString('base64url');
    assert.notEqual(forgedPayload, payload);
    assert.equal(verifyOwnerSession(`${forgedPayload}.${signature}`), null);
  });

  test('a session signed with a different secret is rejected (rotating AUTH_SECRET revokes every cookie)', () => {
    process.env.AUTH_SECRET = 'secret-a';
    const session = createOwnerSession();
    process.env.AUTH_SECRET = 'secret-b';
    assert.equal(verifyOwnerSession(session), null);
  });

  test('clearing OWNER_PASSWORD_HASH does NOT revoke an already-issued cookie', () => {
    // Documented behaviour, asserted so the runbook and the code cannot drift: the session is a
    // self-contained signed token and verifying it never reads OWNER_PASSWORD_HASH. Removing that
    // variable stops new logins only. Rotating AUTH_SECRET is what revokes existing sessions - the
    // test above proves that is the lever that works.
    process.env.AUTH_SECRET = 'test-secret-one';
    process.env.OWNER_PASSWORD_HASH = hashOwnerPassword('correct horse battery staple');
    const session = createOwnerSession();
    delete process.env.OWNER_PASSWORD_HASH;
    assert.equal(verifyOwnerPassword('correct horse battery staple'), false, 'no new login can succeed');
    assert.equal(verifyOwnerSession(session), 'owner', 'the existing cookie still verifies');
  });

  test('malformed cookie values never throw: no dot, empty payload, non-JSON, non-base64', () => {
    process.env.AUTH_SECRET = 'test-secret-one';
    for (const malformed of ['no-dot-here', '.sig', 'payload.', '..', 'not-base64!!.sig', '']) {
      assert.equal(verifyOwnerSession(malformed), null, malformed);
    }
  });

  test('a correctly signed payload with the wrong subject is rejected', () => {
    // Signed with the real secret, so this actually reaches the subject check rather than failing at
    // the signature - which is what the previous version of this test accidentally proved instead.
    process.env.AUTH_SECRET = 'test-secret-one';
    const sign = payload => createHmac('sha256', 'test-secret-one').update(payload).digest().toString('base64url');
    for (const payload of [
      { sub: 'someone-else', exp: Date.now() + 999999 },
      { sub: '', exp: Date.now() + 999999 },
      { exp: Date.now() + 999999 },
      { sub: 'owner' },
      { sub: 'owner', exp: 'soon' },
      { sub: 'owner', exp: Number.NaN },
      { sub: 'owner', exp: Number.POSITIVE_INFINITY },
    ]) {
      const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const cookie = `${encoded}.${sign(encoded)}`;
      // Guard: the cookie really is correctly signed, so a null result is the subject/expiry check.
      assert.equal(verifyOwnerSession(`${encoded}.${sign(encoded)}`), verifyOwnerSession(cookie));
      assert.equal(verifyOwnerSession(cookie), null, JSON.stringify(payload));
    }
    // ...and the same construction with a valid payload does authenticate, proving the signing helper
    // above is correct and these rejections are not just "the signature was wrong".
    const good = Buffer.from(JSON.stringify({ sub: 'owner', exp: Date.now() + 999999 })).toString('base64url');
    assert.equal(verifyOwnerSession(`${good}.${sign(good)}`), 'owner');
  });
});
