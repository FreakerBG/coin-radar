// Owner-secret authentication for the Vercel+Turso deployment. This is a single-owner private tool,
// not multi-user OAuth: one password, verified against a salted-scrypt hash, gates one synthetic
// identity ("owner"). It only ever runs off Sites (runsOutsideSites() in app/chatgpt-auth.ts) and
// never affects the Sites header path, which stays exactly as it was.
//
// Two secrets, each with its own job. They are NOT interchangeable, and removing one does not do the
// other's work - see "Revoking access" below:
//   AUTH_SECRET          HMAC key that signs the session cookie. Unset => no cookie can be issued or
//                        verified, so nothing authenticates.
//   OWNER_PASSWORD_HASH  Canonical scrypt hash (OWNER_PASSWORD_HASH_FORMAT below). Unset => no NEW
//                        login can succeed. Already-issued cookies are self-contained and stay valid
//                        until they expire, because verifying one never consults this value.
//
// Revoking access:
//   - To stop new logins: clear OWNER_PASSWORD_HASH (or set a new one).
//   - To revoke every EXISTING session immediately: rotate AUTH_SECRET. That is the only thing that
//     invalidates cookies already in a browser; see docs/deployment-runbook.md section 10.
//
// Generate OWNER_PASSWORD_HASH with `npm run owner:hash` (scripts/owner-password-hash.mjs), which
// reads the password from the terminal without echoing it and prints only the hash. It calls
// hashOwnerPassword() below, so the documented operator workflow and the login path cannot drift
// apart - tests/owner-auth.test.mjs asserts exactly that.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "coin_radar_owner_session";
export const OWNER_USER_ID = "owner";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// The one canonical OWNER_PASSWORD_HASH format. Self-describing: the scrypt cost parameters that
// produced the key travel with it, so a later change to Node's scrypt defaults (or to the constants
// below) cannot silently stop an already-deployed hash from verifying. Exactly six "$"-separated
// fields, fixed-width lowercase hex for both binary fields:
//
//   scrypt$<N>$<r>$<p>$<saltHex>$<keyHex>
//
// Nothing else is accepted. In particular the earlier "<saltHex>:<hashHex>" shape is not: it was
// ambiguous about whether the salt was the hex text or the bytes that text encodes. The generator
// documented alongside it used the text, verification used the bytes, so no hash produced by the
// documented command could ever authenticate. An ambiguous credential format is exactly what this
// must not have. No deployment has ever had OWNER_PASSWORD_HASH set - the Vercel project's
// environment variable list is empty - so there is no existing hash to stay compatible with.
export const OWNER_PASSWORD_HASH_FORMAT = "scrypt$<N>$<r>$<p>$<saltHex>$<keyHex>";
export const SALT_BYTES = 32;
export const KEY_BYTES = 64;
export const SCRYPT_N = 16384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
// Work bounds enforced when reading a stored hash. A hostile or corrupted OWNER_PASSWORD_HASH must
// not be able to turn one login request into an arbitrarily large allocation or an endless CPU burn.
const MIN_N = 1 << 14, MAX_N = 1 << 20, MAX_R = 32, MAX_P = 16;
// A password longer than this is never a real one. Bounding it keeps a single request from feeding
// megabytes into the (synchronous) KDF; Vercel alone would allow a 4.5 MB body.
export const MAX_PASSWORD_BYTES = 1024;

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
//
// Deliberately stateless: it reads AUTH_SECRET and nothing else. It does NOT consult
// OWNER_PASSWORD_HASH, so clearing that variable does not revoke cookies already issued - rotate
// AUTH_SECRET for that. That is ordinary signed-cookie behaviour rather than a flaw, but it is the
// opposite of what "both secrets are required" would suggest, so it is stated here and in the runbook.
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

// Fixed-width lowercase hex, validated by shape rather than by Buffer.from(value, "hex"): that
// helper does NOT throw on invalid input, it stops at the first bad pair and silently returns the
// prefix it managed to decode. Relying on it would mean a truncated or mistyped OWNER_PASSWORD_HASH
// quietly degraded into a shorter derived-key comparison - "aa:ff" reduced the check to a single
// byte, which accepted roughly 1 in 256 arbitrary passwords - instead of being rejected outright.
function hexOfBytes(value: string, bytes: number): Buffer | null {
  if (value.length !== bytes * 2 || !/^[0-9a-f]+$/.test(value)) return null;
  return Buffer.from(value, "hex");
}

function boundedInt(value: string, min: number, max: number): number | null {
  if (!/^[1-9][0-9]{0,6}$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : null;
}

type ParsedHash = { n: number; r: number; p: number; salt: Buffer; key: Buffer };

// Parses OWNER_PASSWORD_HASH strictly. Anything that is not exactly the canonical format, with
// in-range parameters and exact-width hex, is rejected. There is no lenient path and no second
// accepted encoding, so a mistyped value fails loudly at login instead of weakening the check.
export function parseOwnerPasswordHash(stored: string | undefined | null): ParsedHash | null {
  if (typeof stored !== "string") return null;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const n = boundedInt(parts[1], MIN_N, MAX_N);
  const r = boundedInt(parts[2], 1, MAX_R);
  const p = boundedInt(parts[3], 1, MAX_P);
  // scrypt requires N to be a power of two; anything else makes scryptSync throw.
  if (n === null || r === null || p === null || (n & (n - 1)) !== 0) return null;
  const salt = hexOfBytes(parts[4], SALT_BYTES);
  const key = hexOfBytes(parts[5], KEY_BYTES);
  if (!salt || !key) return null;
  return { n, r, p, salt, key };
}

// Node's default maxmem (32 MB) leaves no headroom above N=16384,r=8, and a stored hash may
// legitimately name a higher cost. Derive the allowance from parameters that were already bounded
// above, so it can never be unbounded.
function maxmemFor(n: number, r: number): number {
  return 256 * n * r;
}

// The one place a password becomes a stored hash. `npm run owner:hash` calls this, and so does the
// integration test that logs in with the result, so the documented operator workflow is the workflow
// that is proven to authenticate.
export function hashOwnerPassword(password: string, salt: Buffer = randomBytes(SALT_BYTES)): string {
  if (typeof password !== "string" || !password) throw new Error("A password is required.");
  if (Buffer.byteLength(password) > MAX_PASSWORD_BYTES) {
    throw new Error(`Password must be at most ${MAX_PASSWORD_BYTES} bytes.`);
  }
  if (salt.length !== SALT_BYTES) throw new Error(`Salt must be ${SALT_BYTES} bytes.`);
  const key = scryptSync(password, salt, KEY_BYTES, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: maxmemFor(SCRYPT_N, SCRYPT_R),
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${key.toString("hex")}`;
}

// Verifies a plaintext password against OWNER_PASSWORD_HASH. Fails closed (false) if the variable is
// unset, not exactly the canonical format, or the password is wrong or over-long. Constant-time
// compare of the derived key; scrypt itself makes brute force over a leaked hash expensive.
export function verifyOwnerPassword(password: string): boolean {
  const parsed = parseOwnerPasswordHash(process.env.OWNER_PASSWORD_HASH);
  if (!parsed) return false;
  if (typeof password !== "string" || !password) return false;
  // Bound the work a single request can ask for before running the (synchronous) KDF.
  if (Buffer.byteLength(password) > MAX_PASSWORD_BYTES) return false;
  let derived: Buffer;
  try {
    derived = scryptSync(password, parsed.salt, parsed.key.length, {
      N: parsed.n, r: parsed.r, p: parsed.p, maxmem: maxmemFor(parsed.n, parsed.r),
    });
  } catch {
    // Parameters that are individually in range can still be rejected by the runtime together.
    return false;
  }
  return derived.length === parsed.key.length && timingSafeEqual(derived, parsed.key);
}
