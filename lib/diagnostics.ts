import {env} from 'cloudflare:workers';

// Server-side failure records for Workers logs: one JSON line per failure, so operators can tell
// storage, schema and provider failures apart. Records never include request bodies, user
// identifiers, credentials or SQL parameters, and reporting never changes a response.
export type FailureLevel = 'error' | 'warn';

const MAX_MESSAGE_LENGTH = 300;

export function redact(text: string): string {
  const token = (env as unknown as {X_BEARER_TOKEN?: string}).X_BEARER_TOKEN;
  return (token ? text.split(token).join('[redacted]') : text)
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
