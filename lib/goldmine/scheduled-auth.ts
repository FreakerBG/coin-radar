// Authorization for the unattended scheduled Goldmine scan (app/api/goldmine/scheduled/route.ts).
// There is no signed-in user and no browser origin here, so sign-in and sameOrigin() (lib/research-db.ts)
// do not apply; a shared secret is the only gate. Two conventions are accepted, either of which is
// sufficient on its own:
//
//   1. `x-goldmine-cron-secret: <GOLDMINE_CRON_SECRET>` - a custom header, for any scheduler that can
//      set an arbitrary header (a Cloudflare Worker cron handler once Sites supports it, section 6 of
//      docs/goldmine-intelligence.md, or a manual/curl trigger).
//   2. `Authorization: Bearer <CRON_SECRET>` - Vercel Cron's native convention: when a `CRON_SECRET`
//      project environment variable is set, Vercel automatically sends it as this header on requests
//      it makes to a `crons` entry in vercel.json. This repository could not independently verify that
//      behavior against a live Vercel deployment (no Vercel account/cron job exists yet to observe);
//      it is implemented here per Vercel's current published documentation and is intentionally kept
//      alongside the custom-header path rather than assumed to be the only mechanism, so a
//      misunderstanding of Vercel's exact request format degrades to "cron secret rejected", not to a
//      silently unauthenticated endpoint.
//
// Fails closed like every check in this codebase (lib/diagnostics.ts, the CSRF check): if the relevant
// env var is unset, that path can never authorize a request, however it is called. Comparisons are
// constant-time so response timing cannot be used to guess the secret.
import { timingSafeEqual } from 'node:crypto';

const CRON_SECRET_HEADER = 'x-goldmine-cron-secret';
const BEARER_PREFIX = 'Bearer ';

function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return timingSafeEqual(bufA, bufA) && false;
  return timingSafeEqual(bufA, bufB);
}

// Reads process.env directly (not the Cloudflare-shaped `env` from cloudflare:workers/
// lib/vercel-cloudflare-workers.ts): this runs during route handling on both platforms, and
// process.env is available in both the Workers runtime (via nodejs_compat) and on Vercel.
function secret(name: string): string | undefined {
  const value = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return value && value.length > 0 ? value : undefined;
}

export function isAuthorizedScheduledScan(request: Request): boolean {
  const cronSecret = secret('GOLDMINE_CRON_SECRET');
  const providedHeader = request.headers.get(CRON_SECRET_HEADER);
  if (cronSecret && providedHeader && timingSafeEqualString(providedHeader, cronSecret)) return true;

  const bearerSecret = secret('CRON_SECRET');
  const authorization = request.headers.get('authorization');
  if (bearerSecret && authorization?.startsWith(BEARER_PREFIX)) {
    const provided = authorization.slice(BEARER_PREFIX.length);
    if (timingSafeEqualString(provided, bearerSecret)) return true;
  }

  return false;
}
