// Authorization for automated Goldmine scans, separate from the signed-in, same-origin POST route.
// There is no ChatGPT session and no Origin header on an automated call, so a dedicated shared secret
// stands in for both. Fails closed: an unset, empty or misconfigured secret never authorizes anything,
// even a request that also sends an empty header - the secret must be a real, configured value that
// matches exactly. Uses only Web-standard APIs (TextEncoder, crypto.subtle), available in both the
// Workers runtime and the Node test harness, so this needs no nodejs_compat surface.
import {env} from 'cloudflare:workers';

export const SCHEDULED_SECRET_HEADER = 'x-goldmine-cron-secret';

function configuredSecret(): string | null {
  const secret = (env as unknown as {GOLDMINE_CRON_SECRET?: string}).GOLDMINE_CRON_SECRET;
  return typeof secret === 'string' && secret.length > 0 ? secret : null;
}

// Constant-time comparison against timing side-channels: hash both sides with a per-call random key
// (HMAC-SHA-256) and compare the digests, so the comparison's timing depends only on the fixed digest
// length, never on where the secret and the provided value first differ or on their raw lengths.
async function secretsMatch(expected: string, provided: string): Promise<boolean> {
  const key = await crypto.subtle.generateKey({name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.sign('HMAC', key, encoder.encode(expected)),
    crypto.subtle.sign('HMAC', key, encoder.encode(provided)),
  ]);
  const bytesA = new Uint8Array(a), bytesB = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) diff |= bytesA[i] ^ bytesB[i];
  return diff === 0;
}

export async function authorizeScheduledScan(request: Request): Promise<boolean> {
  const secret = configuredSecret();
  if (!secret) return false;
  const provided = request.headers.get(SCHEDULED_SECRET_HEADER);
  return !!provided && await secretsMatch(secret, provided);
}
