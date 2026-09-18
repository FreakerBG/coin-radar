// What the application requires of the D1 schema, derived from the SQL in app/ and lib/.
// GET /api/health checks the tables and columns at runtime; tests/migrations/schema-contract.mjs
// checks the whole contract against every migration.
export type ColumnAffinity = 'TEXT' | 'INTEGER' | 'REAL';

export type TableRequirement = {
  // Required columns and their SQLite affinity. All are NOT NULL unless listed in `nullable`.
  columns: Record<string, ColumnAffinity>;
  nullable?: string[];
  // The conflict target the application relies on (PRIMARY KEY or UNIQUE on exactly these columns).
  key: string[];
  // The columns the application's INSERT supplies; every other column must be nullable or defaulted.
  inserted: string[];
  defaults?: Record<string, number | string | null>;
  // Shared by every user: a new column needs a cross-user isolation review.
  shared?: boolean;
};

export const requiredTables: Record<string, TableRequirement> = {
  // lib/research-db.ts getConfig reads by user; POST /api/portfolio upserts ON CONFLICT(user_id), bumping revision.
  research_accounts: {
    columns: {user_id: 'TEXT', config: 'TEXT', revision: 'INTEGER'},
    key: ['user_id'],
    inserted: ['user_id', 'config'],
    defaults: {revision: 0},
  },
  // Owned by user_id. INSERT OR IGNORE on id makes recording idempotent; open means closed_at IS NULL.
  research_positions: {
    columns: {id: 'TEXT', user_id: 'TEXT', data: 'TEXT', closed_at: 'TEXT', revision: 'INTEGER'},
    nullable: ['closed_at'],
    key: ['id'],
    inserted: ['id', 'user_id', 'data'],
    defaults: {closed_at: null, revision: 0},
  },
  // Owned by user_id. POST /api/monitor stores one event per position and rule (INSERT OR IGNORE on id);
  // GET /api/portfolio orders by created_at.
  research_events: {
    columns: {id: 'TEXT', user_id: 'TEXT', position_id: 'TEXT', kind: 'TEXT', data: 'TEXT', created_at: 'TEXT'},
    key: ['id'],
    inserted: ['id', 'user_id', 'position_id', 'kind', 'data', 'created_at'],
  },
  // acquireLock upserts ON CONFLICT(id) and compares expires as epoch milliseconds.
  research_locks: {
    columns: {id: 'TEXT', owner: 'TEXT', expires: 'INTEGER'},
    key: ['id'],
    inserted: ['id', 'owner', 'expires'],
  },
  // One row of public X evidence per contract, shared by all users (ON CONFLICT(address)); fetched_at is
  // epoch milliseconds. Per-user quota or connection state must never be stored here.
  social_cache: {
    columns: {address: 'TEXT', data: 'TEXT', fetched_at: 'INTEGER'},
    key: ['address'],
    inserted: ['address', 'data', 'fetched_at'],
    shared: true,
  },
  // Per-user UTC-daily quota rows (id x:<user>:<date>); the reservation upserts ON CONFLICT(id).
  social_usage: {
    columns: {id: 'TEXT', requests: 'INTEGER'},
    key: ['id'],
    inserted: ['id', 'requests'],
  },
  // lib/goldmine/signals.ts: one market observation per token, model version, state and 6h bucket
  // (INSERT OR IGNORE on id). Shared by every user and holds no user data; detected_at is epoch ms.
  goldmine_signals: {
    columns: {
      id: 'TEXT', address: 'TEXT', pair: 'TEXT', symbol: 'TEXT', model_version: 'TEXT', state: 'TEXT', score: 'INTEGER',
      opportunity: 'INTEGER', detected_at: 'INTEGER', detected_price: 'REAL', snapshot: 'TEXT', assessment: 'TEXT',
    },
    key: ['id'],
    inserted: ['id', 'address', 'pair', 'symbol', 'model_version', 'state', 'score', 'opportunity', 'detected_at', 'detected_price', 'snapshot', 'assessment'],
    shared: true,
  },
  // One row per signal and horizon (INSERT OR IGNORE on the pair), created pending; evaluation moves a
  // pending row to observed, unavailable or missed exactly once. Times are epoch ms.
  goldmine_outcomes: {
    columns: {
      signal_id: 'TEXT', horizon: 'TEXT', due_at: 'INTEGER', deadline_at: 'INTEGER', status: 'TEXT',
      observed_at: 'INTEGER', price: 'REAL', liquidity: 'REAL',
    },
    nullable: ['observed_at', 'price', 'liquidity'],
    key: ['signal_id', 'horizon'],
    inserted: ['signal_id', 'horizon', 'due_at', 'deadline_at'],
    defaults: {status: 'pending', observed_at: null, price: null, liquidity: null},
    shared: true,
  },
};

// One read-only statement per required table that fails to compile if the table or a column is missing.
export function schemaProbes(): {table: string; sql: string}[] {
  return Object.entries(requiredTables).map(([table, requirement]) => ({
    table,
    sql: `SELECT ${Object.keys(requirement.columns).join(', ')} FROM ${table} LIMIT 0`,
  }));
}
