// Vercel builds do not provide Cloudflare Worker bindings, so next.config.ts aliases
// `cloudflare:workers` to this module whenever `process.env.VERCEL` is set. This is a second,
// independent production path (Vercel + Turso) alongside the original Cloudflare/D1/Sites path,
// which this file never touches.
//
// `env.DB` resolves to a Turso (libSQL) adapter (lib/turso-db.ts) only when both
// `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` are present. If either is missing, `env` stays empty
// (frozen, `DB` absent) so every D1-backed route keeps failing closed (503) exactly as before this
// migration - never a silent degrade or a faked success. Provider secrets that Cloudflare exposes on
// `env` (X_BEARER_TOKEN) and the Goldmine cron secret (GOLDMINE_CRON_SECRET) flow through from
// `process.env` here the same way, so route code that reads them via `env` needs no branching on
// which platform it is running on.
import {createTursoDatabase} from './turso-db';

const databaseUrl = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

const db = databaseUrl && authToken ? createTursoDatabase({url: databaseUrl, authToken}) : undefined;

export const env = Object.freeze({
  ...(db ? {DB: db} : {}),
  ...(process.env.X_BEARER_TOKEN ? {X_BEARER_TOKEN: process.env.X_BEARER_TOKEN} : {}),
  ...(process.env.GOLDMINE_CRON_SECRET ? {GOLDMINE_CRON_SECRET: process.env.GOLDMINE_CRON_SECRET} : {}),
}) as unknown as Cloudflare.Env;
