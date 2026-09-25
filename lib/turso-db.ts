// Turso (libSQL) adapter for the Vercel+Turso path. Implements exactly the D1-shaped surface the
// application already calls against `env.DB` on Cloudflare/Sites - prepare a statement, bind its
// arguments, then run it with first()/all()/run() - plus the `result.meta.changes` field a few
// routes read after run(). Nothing here is speculative: every method exists because grep found a
// real call site in lib/research-db.ts, lib/goldmine/signals.ts, app/api/*/route.ts or lib/diagnostics.ts.
//
// Turso/libSQL is SQLite-wire-compatible, so the hand-written SQL (including SQLite-specific syntax
// like `INSERT ... ON CONFLICT ... RETURNING`) runs unchanged; only this client/adapter differs from
// D1. A caller still gets plain JSON-serializable rows back, never a libSQL `Row` proxy, so existing
// call sites that spread or JSON.stringify a row keep working exactly as they do against D1.
import {createClient, type Client, type InArgs, type Row} from '@libsql/client';

type PlainRow = Record<string, unknown>;

function toPlainRow(row: Row, columns: string[]): PlainRow {
  const plain: PlainRow = {};
  columns.forEach((column, index) => {
    plain[column] = row[index];
  });
  return plain;
}

class TursoPreparedStatement {
  // A function, not a Client: the client is built on first execute() so that importing this module
  // (which Next.js does during a build) never constructs one. See createTursoDatabase below.
  private readonly connect: () => Client;
  private readonly sql: string;
  private readonly args: InArgs;

  constructor(connect: () => Client, sql: string, args: InArgs) {
    this.connect = connect;
    this.sql = sql;
    this.args = args;
  }

  bind(...args: unknown[]): TursoPreparedStatement {
    return new TursoPreparedStatement(this.connect, this.sql, args as InArgs);
  }

  async first<T = PlainRow>(): Promise<T | null> {
    const result = await this.connect().execute({sql: this.sql, args: this.args});
    const [row] = result.rows;
    return row ? (toPlainRow(row, result.columns) as T) : null;
  }

  async all<T = PlainRow>(): Promise<{results: T[]; success: true; meta: Record<string, never>}> {
    const result = await this.connect().execute({sql: this.sql, args: this.args});
    return {
      results: result.rows.map(row => toPlainRow(row, result.columns) as T),
      success: true,
      meta: {},
    };
  }

  async run(): Promise<{success: true; meta: {changes: number}}> {
    const result = await this.connect().execute({sql: this.sql, args: this.args});
    return {success: true, meta: {changes: Number(result.rowsAffected)}};
  }
}

export type TursoDatabase = {
  prepare(sql: string): TursoPreparedStatement;
};

// The libSQL client is created on first use, not here. Next.js evaluates module scope during the
// build to prerender and collect page data, and lib/vercel-cloudflare-workers.ts (which calls this)
// is module scope reached by every D1-backed route. Constructing eagerly meant a build with a
// malformed or unreachable TURSO_DATABASE_URL could fail at build time rather than at request time,
// and made "the client is never constructed during a build" untrue. Deferring it keeps a build
// independent of database configuration, which is what the runbook promises.
//
// One client per module instance, reused across invocations: on serverless that means one per warm
// instance, which is what @libsql/client's HTTP transport expects. Nothing here opens a connection
// until a statement actually runs.
export function createTursoDatabase(config: {url: string; authToken: string}): TursoDatabase {
  let client: Client | undefined;
  const connect = () => (client ??= createClient(config));
  return {
    prepare(sql: string) {
      return new TursoPreparedStatement(connect, sql, []);
    },
  };
}
