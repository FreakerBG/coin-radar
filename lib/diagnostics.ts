import {env} from 'cloudflare:workers';

// Server-side failure records for Workers logs: one JSON line per failure, so operators can tell
// storage, schema and provider failures apart. Records never include request bodies, user
// identifiers, credentials or SQL parameters, and reporting never changes a response.
export type FailureLevel = 'error' | 'warn';

const MAX_MESSAGE_LENGTH = 300;

export function redact(text: string): string {
  // The generic `Bearer <token>` pattern below already catches CRON_SECRET wherever it appears with
  // that prefix (Vercel Cron's own convention), but GOLDMINE_CRON_SECRET travels as a bare header
  // value with no prefix (lib/goldmine/scheduled-auth.ts), so it needs the same explicit, exact-value
  // redaction X_BEARER_TOKEN already gets - otherwise a message that echoes a rejected header value
  // verbatim (e.g. "rejected header value <secret> for scheduled scan") would leak it unredacted.
  const secrets = env as unknown as {X_BEARER_TOKEN?: string; GOLDMINE_CRON_SECRET?: string; CRON_SECRET?: string};
  let redacted = text;
  for (const secret of [secrets.X_BEARER_TOKEN, secrets.GOLDMINE_CRON_SECRET, secrets.CRON_SECRET]) {
    if (secret) redacted = redacted.split(secret).join('[redacted]');
  }
  return redacted
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/[^\s@"'<>()]+@[^\s@"'<>()]+\.[a-z]{2,}/gi, '[email]')
    .slice(0, MAX_MESSAGE_LENGTH);
}

function describe(error: unknown): {name: string; message: string; cause?: {name: string; message: string}} {
  if (!(error instanceof Error)) return {name: typeof error, message: redact(String(error))};
  const cause = error.cause instanceof Error ? {name: redact(error.cause.name), message: redact(error.cause.message)} : undefined;
  return {name: redact(error.name), message: redact(error.message), ...(cause ? {cause} : {})};
}

// Called from catch and finally blocks, so it must never throw: a value that cannot be described
// (a throwing getter or toString) is recorded as unknown, and a failing console is ignored.
export function reportFailure(route: string, operation: string, error: unknown, level: FailureLevel = 'error') {
  try {
    let described;
    try {
      described = describe(error);
    } catch {
      described = {name: 'unknown', message: 'The failure could not be described.'};
    }
    const record = JSON.stringify({event: 'coin_radar.failure', level, route, operation, error: described});
    if (level === 'warn') console.warn(record);
    else console.error(record);
  } catch {
    // Reporting is best effort; the caller's response must not change.
  }
}

export type ScanStatus = 'checked' | 'busy' | 'provider_unavailable';

// One structured JSON line per scan invocation (app/api/goldmine/scheduled/route.ts), so an operator
// can tell how many of a day's invocations actually ran the pipeline versus found the shared lock held
// versus hit a discovery-provider failure - without a new table or a database read. This exists because
// a future 96-invocation/day detector makes that split worth watching for capacity, not just debugging a
// single failure; a normal day is expected to be almost entirely `checked`, and a sustained run of
// `busy` or `provider_unavailable` is the signal an operator would otherwise only see by reading every
// invocation's raw HTTP response individually. Carries no candidates, addresses or secrets - only the
// route, which method produced it, the outcome and, when given, numeric/enum details (duration, counts,
// contract-safety coverage) that the caller builds from counts alone. Best effort, like reportFailure: it
// must never throw or change the caller's response.
export type ScanOutcomeDetails = {
  durationMs: number;
  candidates?: number;
  opportunities?: number;
  newSignals?: number;
  outcomesSettled?: boolean;
  alertsQueued?: number | null;
  safety?: {eligible: number; verified: number; unsafe: number; unavailable: number; requests: number; cacheHits: number; rateLimited: boolean; cooldown: string; unchecked: number};
};

export function reportScanOutcome(route: string, mode: 'daily' | 'detection', status: ScanStatus, details?: ScanOutcomeDetails) {
  try {
    console.log(JSON.stringify({event: 'coin_radar.scan_outcome', route, mode, status, ...details}));
  } catch {
    // Reporting is best effort; the caller's response must not change.
  }
}
