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
  const cause = error.cause instanceof Error ? {name: error.cause.name, message: redact(error.cause.message)} : undefined;
  return {name: error.name, message: redact(error.message), ...(cause ? {cause} : {})};
}

export function reportFailure(route: string, operation: string, error: unknown, level: FailureLevel = 'error') {
  const record = JSON.stringify({event: 'coin_radar.failure', level, route, operation, error: describe(error)});
  if (level === 'warn') console.warn(record);
  else console.error(record);
}
