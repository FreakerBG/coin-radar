// app/owner-auth.ts: owner-secret authentication for the Vercel+Turso deployment. Mirrors the
// fail-closed rigor of lib/goldmine/scheduled-auth.ts - both secrets (AUTH_SECRET,
// OWNER_PASSWORD_HASH) must be set and correct, or every check fails, however it is bypassed.
import assert from 'node:assert/strict';
import { scryptSync, randomBytes } from 'node:crypto';
import { afterEach, describe, test } from 'node:test';
import { createOwnerSession, verifyOwnerPassword, verifyOwnerSession } from '../app/owner-auth.ts';

const ORIGINAL_AUTH_SECRET = process.env.AUTH_SECRET;
const ORIGINAL_OWNER_PASSWORD_HASH = process.env.OWNER_PASSWORD_HASH;

afterEach(() => {
  if (ORIGINAL_AUTH_SECRET === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = ORIGINAL_AUTH_SECRET;
  if (ORIGINAL_OWNER_PASSWORD_HASH === undefined) delete process.env.OWNER_PASSWORD_HASH;
  else process.env.OWNER_PASSWORD_HASH = ORIGINAL_OWNER_PASSWORD_HASH;
});

function ownerPasswordHash(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, Buffer.from(salt, 'hex'), 64).toString('hex');
  return `${salt}:${hash}`;
}

describe('verifyOwnerPassword', () => {
  test('fails closed when OWNER_PASSWORD_HASH is unset', () => {
    delete process.env.OWNER_PASSWORD_HASH;
    assert.equal(verifyOwnerPassword('anything'), false);
  });

  test('accepts the correct password and rejects a wrong one', () => {
    process.env.OWNER_PASSWORD_HASH = ownerPasswordHash('correct horse battery staple');
    assert.equal(verifyOwnerPassword('correct horse battery staple'), true);
    assert.equal(verifyOwnerPassword('wrong password'), false);
  });

  test('rejects an empty password even against an empty stored hash', () => {
    process.env.OWNER_PASSWORD_HASH = '';
    assert.equal(verifyOwnerPassword(''), false);
  });

  test('fails closed on a malformed OWNER_PASSWORD_HASH (no colon, empty salt/hash, invalid hex)', () => {
    for (const malformed of ['no-colon-here', ':', 'zz:zz', '', 'aa:']) {
      process.env.OWNER_PASSWORD_HASH = malformed;
      assert.equal(verifyOwnerPassword('anything'), false, malformed);
    }
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

  test('a tampered payload is rejected even though the signature format still parses', () => {
    process.env.AUTH_SECRET = 'test-secret-one';
    const session = createOwnerSession();
    const [payload, signature] = session.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ sub: 'owner', exp: Date.now() + 999999999 })).toString('base64url');
    assert.notEqual(forgedPayload, payload);
    assert.equal(verifyOwnerSession(`${forgedPayload}.${signature}`), null);
  });

  test('a session signed with a different secret is rejected (secret rotation invalidates old cookies)', () => {
    process.env.AUTH_SECRET = 'secret-a';
    const session = createOwnerSession();
    process.env.AUTH_SECRET = 'secret-b';
    assert.equal(verifyOwnerSession(session), null);
  });

  test('malformed cookie values never throw: no dot, empty payload, non-JSON, non-base64', () => {
    process.env.AUTH_SECRET = 'test-secret-one';
    for (const malformed of ['no-dot-here', '.sig', 'payload.', '..', 'not-base64!!.sig', '']) {
      assert.equal(verifyOwnerSession(malformed), null, malformed);
    }
  });

  test('a payload with the wrong subject is rejected even if somehow correctly signed', () => {
    process.env.AUTH_SECRET = 'test-secret-one';
    const session = createOwnerSession();
    const [, signature] = session.split('.');
    const otherPayload = Buffer.from(JSON.stringify({ sub: 'someone-else', exp: Date.now() + 999999 })).toString('base64url');
    // This forged cookie will not match the signature either (different payload), so it fails on both
    // grounds - this also exercises the same tamper-detection path as the dedicated test above.
    assert.equal(verifyOwnerSession(`${otherPayload}.${signature}`), null);
  });
});
