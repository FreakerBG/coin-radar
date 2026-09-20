// Owner-secret authentication for the Vercel+Turso deployment. This is a single-owner private tool,
// not multi-user OAuth: one password, verified against a salted-scrypt hash, gates one synthetic
// identity ("owner"). It only ever runs off Sites (runsOutsideSites() in app/chatgpt-auth.ts) and
// never affects the Sites header path, which stays exactly as it was.
//
// Two secrets, both required, both fail-closed when unset - mirroring lib/goldmine/scheduled-auth.ts:
//   AUTH_SECRET          HMAC key that signs the session cookie. Unset => no cookie can ever verify.
//   OWNER_PASSWORD_HASH  "<saltHex>:<hashHex>", scrypt(password, salt, 64). Unset => login always fails.
// Generate OWNER_PASSWORD_HASH with:
//   node -e "const c=require('crypto');const s=c.randomBytes(16).toString('hex');console.log(s+':'+c.scryptSync(process.argv[1],s,64).toString('hex'))" '<password>'
import { createHmac, scryptSync, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "coin_radar_owner_session";
export const OWNER_USER_ID = "owner";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

type SessionPayload = { sub: string; exp: number };

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Compare fixed-length digests so length differences never leak through early return timing;
  // when lengths differ, compare bufA against itself so no data-dependent branch is taken.
  if (bufA.length !== bufB.length) return timingSafeEqual(bufA, bufA) && false;
  return timingSafeEqual(bufA, bufB);
}

function sign(payload: string, secret: string): string {
  return base64url(createHmac("sha256", secret).update(payload).digest());
}

// Builds a signed session cookie value ("payload.signature"), or null if AUTH_SECRET is unset -
// fail closed, never issue a cookie nothing can later verify.
export function createOwnerSession(now = Date.now()): string | null {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  const payload: SessionPayload = { sub: OWNER_USER_ID, exp: now + SESSION_TTL_MS };
  const encodedPayload = base64url(JSON.stringify(payload));
  return `${encodedPayload}.${sign(encodedPayload, secret)}`;
}

// Verifies a cookie value against AUTH_SECRET: checks the HMAC (constant-time), the payload shape and
// expiry. Returns the synthetic owner user id on success, null on any failure - missing secret,
// missing/malformed cookie, bad signature, tampered payload, unexpected subject or expiry in the past.
// Never throws: a malformed cookie is exactly as unauthenticated as a missing one.
export function verifyOwnerSession(cookieValue: string | undefined | null, now = Date.now()): string | null {
  const secret = process.env.AUTH_SECRET;
  if (!secret || !cookieValue) return null;
  const separator = cookieValue.lastIndexOf(".");
  if (separator <= 0) return null;
  const encodedPayload = cookieValue.slice(0, separator);
  const signature = cookieValue.slice(separator + 1);
  if (!timingSafeEqualString(sign(encodedPayload, secret), signature)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    typeof payload !== "object" || payload === null ||
    (payload as Partial<SessionPayload>).sub !== OWNER_USER_ID ||
    typeof (payload as Partial<SessionPayload>).exp !== "number"
  ) return null;
  const { exp } = payload as SessionPayload;
  if (!Number.isFinite(exp) || exp <= now) return null;
  return OWNER_USER_ID;
}

// Verifies a plaintext password against OWNER_PASSWORD_HASH ("<saltHex>:<hashHex>", scrypt). Fails
// closed (false) if the env var is unset, malformed, or the password is wrong. Constant-time compare
// of the derived key; scrypt itself makes brute force over a leaked hash expensive.
export function verifyOwnerPassword(password: string): boolean {
  const stored = process.env.OWNER_PASSWORD_HASH;
  if (!stored || typeof password !== "string" || !password) return false;
  const separator = stored.indexOf(":");
  if (separator <= 0) return false;
  const saltHex = stored.slice(0, separator);
  const hashHex = stored.slice(separator + 1);
  let salt: Buffer, expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (!salt.length || !expected.length) return false;
  const derived = scryptSync(password, salt, expected.length);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
