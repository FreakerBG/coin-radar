// Goldmine signal tracking in D1. A signal records a scored candidate at detection: its snapshot, its
// assessment and the provider price at that moment. Each signal gets one outcome row per horizon,
// evaluated once, only inside that horizon's window: a check that comes too late marks the outcome
// missed instead of recording a later price as if it were the horizon's. Signals are shared market
// observations and hold no user data. Prices are provider quotes, not executable prices.
import {reportFailure} from '../diagnostics';
import {fetchJson} from '../market';
import {MODEL_VERSION, type Assessment} from './score';
import {at, contractSafetySummary, socialEvidence, WINDOWS, type CandidateSnapshot} from './snapshot';

const MINUTE = 60000, HOUR = 60 * MINUTE;
export const HORIZONS = [
  {id: '15m', after: 15 * MINUTE, window: 5 * MINUTE},
  {id: '1h', after: HOUR, window: 15 * MINUTE},
  {id: '6h', after: 6 * HOUR, window: HOUR},
  {id: '24h', after: 24 * HOUR, window: 3 * HOUR},
] as const;
// A token can be recorded again in the same state once per bucket, so a pattern that persists does not
// create a signal per scan.
export const SIGNAL_BUCKET_MS = 6 * HOUR;
// DEX Screener's pairs endpoint accepts up to 30 pair addresses per request. A scan sends at most
// MAX_OUTCOME_BATCHES requests (150 pairs), in parallel so it stays well inside the 60-second scan lock.
export const MAX_PAIRS_PER_REQUEST = 30;
export const MAX_OUTCOME_BATCHES = 5;
// Signals written per INSERT. A signal with its snapshot and assessment is about 4 KB of JSON, so ten keep
// each bound value far below D1's 100 KB statement and 2 MB value limits.
export const SIGNALS_PER_INSERT = 10;

export type Scored = {snapshot: CandidateSnapshot; assessment: Assessment};
// provider: 'partial' when some batches failed. deferred: due pool/token pairs left for a later scan
// because this scan reached its request cap; their windows stay open until their deadlines.
export type OutcomeRun = {provider: 'not_needed' | 'ok' | 'partial' | 'unavailable'; observed: number; unavailable: number; missed: number; deferred: number};

export const signalId = (assessment: Assessment, detectedAt: number) =>
  `${assessment.modelVersion}:${assessment.address}:${assessment.state}:${Math.floor(detectedAt / SIGNAL_BUCKET_MS)}`;

// Adds cached public X evidence to each snapshot. It never requests X.
export async function attachSocialEvidence(database: D1Database, snapshots: CandidateSnapshot[]): Promise<CandidateSnapshot[]> {
  if (!snapshots.length) return snapshots;
  const rows = await database.prepare('SELECT address, data, fetched_at FROM social_cache WHERE address IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(snapshots.map(snapshot => snapshot.address))).all<{address: string; data: string; fetched_at: number}>();
  const evidence = new Map(rows.results.map(row => {
    let data: unknown = null;
    try { data = JSON.parse(row.data); } catch { /* A malformed row is no evidence. */ }
    return [row.address, socialEvidence(data, row.fetched_at)];
  }));
  return snapshots.map(snapshot => ({...snapshot, social: evidence.get(snapshot.address) ?? null}));
}

// Records every scored candidate that has a price, and its pending outcomes. Returns the number of new
// signals; a candidate already recorded in the same state and bucket is left unchanged.
export async function recordSignals(database: D1Database, scored: Scored[], detectedAt: number): Promise<number> {
  const rows = scored.filter(({assessment}) => assessment.priceUsd !== null).map(({snapshot, assessment}) => ({
    id: signalId(assessment, detectedAt),
    address: assessment.address,
    pair: assessment.pair,
    symbol: assessment.symbol,
    modelVersion: assessment.modelVersion,
    state: assessment.state,
    score: assessment.score,
    opportunity: assessment.opportunity ? 1 : 0,
    detectedAt,
    detectedPrice: assessment.priceUsd,
    snapshot: JSON.stringify(snapshot),
    assessment: JSON.stringify(assessment),
  }));
  let inserted = 0;
  const horizons = JSON.stringify(Object.fromEntries(HORIZONS.map(({id, after, window}) => [id, {after, window}])));
  for (let index = 0; index < rows.length; index += SIGNALS_PER_INSERT) {
    const chunk = rows.slice(index, index + SIGNALS_PER_INSERT);
    const result = await database.prepare("INSERT OR IGNORE INTO goldmine_signals (id, address, pair, symbol, model_version, state, score, opportunity, detected_at, detected_price, snapshot, assessment) SELECT json_extract(value, '$.id'), json_extract(value, '$.address'), json_extract(value, '$.pair'), json_extract(value, '$.symbol'), json_extract(value, '$.modelVersion'), json_extract(value, '$.state'), json_extract(value, '$.score'), json_extract(value, '$.opportunity'), json_extract(value, '$.detectedAt'), json_extract(value, '$.detectedPrice'), json_extract(value, '$.snapshot'), json_extract(value, '$.assessment') FROM json_each(?)")
      .bind(JSON.stringify(chunk)).run();
    inserted += result.meta.changes ?? 0;
    await database.prepare("INSERT OR IGNORE INTO goldmine_outcomes (signal_id, horizon, due_at, deadline_at) SELECT s.id, h.key, s.detected_at + json_extract(h.value, '$.after'), s.detected_at + json_extract(h.value, '$.after') + json_extract(h.value, '$.window') FROM goldmine_signals s JOIN json_each(?) h WHERE s.id IN (SELECT value FROM json_each(?))")
      .bind(horizons, JSON.stringify(chunk.map(row => row.id))).run();
  }
  return inserted;
}

// Settles due outcomes. Pending outcomes whose window has closed become missed. The rest are grouped by
// recorded pool, ordered by the earliest closing window (then pool and token, so batches are
// deterministic), and read in batches of at most 30 pools. For each pool a valid price is observed; a
// successful response without the pool or its price is unavailable (possibly delisted). A failed batch
// leaves only its own outcomes pending for the next scan; other batches settle normally.
export async function evaluateOutcomes(database: D1Database, now: number): Promise<OutcomeRun> {
  const missed = (await database.prepare("UPDATE goldmine_outcomes SET status = 'missed' WHERE status = 'pending' AND deadline_at < ?").bind(now).run()).meta.changes ?? 0;
  const due = (await database.prepare("SELECT s.pair AS pair, s.address AS address, MIN(o.deadline_at) AS deadline FROM goldmine_outcomes o JOIN goldmine_signals s ON s.id = o.signal_id WHERE o.status = 'pending' AND o.due_at <= ? GROUP BY s.pair, s.address ORDER BY deadline, s.pair, s.address")
    .bind(now).all<{pair: string; address: string; deadline: number}>()).results;
  const run: OutcomeRun = {provider: 'not_needed', observed: 0, unavailable: 0, missed, deferred: 0};
  if (!due.length) return run;

  const pairs = [...new Set(due.map(row => row.pair))];
  const batches: string[][] = [];
  for (let index = 0; index < pairs.length && batches.length < MAX_OUTCOME_BATCHES; index += MAX_PAIRS_PER_REQUEST) batches.push(pairs.slice(index, index + MAX_PAIRS_PER_REQUEST));
  const requested = new Set(batches.flat());
  run.deferred = due.filter(row => !requested.has(row.pair)).length;

  const responses = await Promise.allSettled(batches.map(batch => fetchJson('https://api.dexscreener.com/latest/dex/pairs/solana/' + batch.join(','), 10000)));
  let failed = 0;
  for (const [index, response] of responses.entries()) {
    if (response.status === 'rejected') {
      failed++;
      reportFailure('goldmine', 'outcome-provider', response.reason, 'warn');
      continue;
    }
    const listed = at(response.value, 'pairs');
    const pools = Array.isArray(listed) ? listed : [];
    const batch = new Set(batches[index]);
    for (const {pair, address} of due.filter(row => batch.has(row.pair))) {
      const pool = pools.find(p => at(p, 'chainId') === 'solana' && at(p, 'pairAddress') === pair && at(p, 'baseToken', 'address') === address);
      const price = Number(at(pool, 'priceUsd') ?? NaN);
      const liquidity = Number(at(pool, 'liquidity', 'usd') ?? NaN);
      const valid = Number.isFinite(price) && price > 0;
      const result = await database.prepare("UPDATE goldmine_outcomes SET status = ?, observed_at = ?, price = ?, liquidity = ? WHERE status = 'pending' AND due_at <= ? AND deadline_at >= ? AND signal_id IN (SELECT id FROM goldmine_signals WHERE pair = ? AND address = ?)")
        .bind(valid ? 'observed' : 'unavailable', now, valid ? price : null, valid && Number.isFinite(liquidity) && liquidity >= 0 ? liquidity : null, now, now, pair, address).run();
      run[valid ? 'observed' : 'unavailable'] += result.meta.changes ?? 0;
    }
  }
  run.provider = failed === 0 ? 'ok' : failed === batches.length ? 'unavailable' : 'partial';
  return run;
}

const percent = (value: number | null) => value === null ? null : Number((value * 100).toFixed(2));

// A stored snapshot is always written as JSON.stringify of a real CandidateSnapshot (recordSignals), but
// a row can still predate a field (an older model version's snapshot shape) or, in principle, contain
// corrupt JSON. Either must degrade to "no evidence", never crash the whole tracking read for every
// other signal.
function parseSnapshot(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return null; }
}

// A stored assessment is always written as JSON.stringify of a real Assessment (recordSignals); the same
// defensive treatment as parseSnapshot applies to any row that predates a field or holds corrupt JSON.
function parseAssessment(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return null; }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isFiniteOrNull = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isFinite(value));
const isFlow = (value: unknown): boolean => isPlainObject(value) && isFiniteOrNull(value.buys) && isFiniteOrNull(value.sells);
const everyWindow = (value: unknown, check: (window: unknown) => boolean): boolean => isPlainObject(value) && WINDOWS.every(window => check(value[window]));

// Structural validation of a stored, parsed snapshot value against the fields replay (scoreCandidate) and
// reporting actually read. This is not a full schema validator: it rejects the shapes a real
// CandidateSnapshot can never be (an array, `{}`, `null`, a wrong primitive type, a missing nested field)
// without re-deriving every rule snapshot.ts already enforces at write time. `typeof value === 'object'`
// alone is not enough - `[]`, `{}` and a partially-shaped object all pass that check but would throw or
// silently misbehave once scoreCandidate reads into them.
export function isValidStoredSnapshot(value: unknown): value is CandidateSnapshot {
  if (!isPlainObject(value)) return false;
  if (typeof value.address !== 'string' || !value.address) return false;
  if (typeof value.pair !== 'string' || !value.pair) return false;
  if (typeof value.symbol !== 'string') return false;
  if (typeof value.observedAt !== 'number' || !Number.isFinite(value.observedAt)) return false;
  if (typeof value.promoted !== 'boolean') return false;
  if (!isFiniteOrNull(value.priceUsd) || !isFiniteOrNull(value.liquidityUsd) || !isFiniteOrNull(value.marketCapUsd) || !isFiniteOrNull(value.fdvUsd) || !isFiniteOrNull(value.ageMinutes)) return false;
  if (!everyWindow(value.volumeUsd, isFiniteOrNull)) return false;
  if (!everyWindow(value.priceChangePct, isFiniteOrNull)) return false;
  if (!everyWindow(value.txns, isFlow)) return false;
  if (!isPlainObject(value.links) || typeof value.links.websites !== 'number' || typeof value.links.socials !== 'number') return false;
  if (!isPlainObject(value.contractSafety) || typeof value.contractSafety.status !== 'string') return false;
  return true;
}

// Structural validation of a stored, parsed assessment value against the fields replay and reporting
// actually read (modelVersion, state, score, opportunity, blockers[].id, address/pair/symbol for display).
// Same rationale as isValidStoredSnapshot: reject arrays, `{}`, `null` and wrong-typed or missing fields.
export function isValidStoredAssessment(value: unknown): value is Assessment {
  if (!isPlainObject(value)) return false;
  if (typeof value.modelVersion !== 'string' || !value.modelVersion) return false;
  if (typeof value.address !== 'string' || typeof value.pair !== 'string' || typeof value.symbol !== 'string') return false;
  if (typeof value.state !== 'string') return false;
  if (typeof value.score !== 'number' || !Number.isFinite(value.score)) return false;
  if (typeof value.opportunity !== 'boolean') return false;
  if (!Array.isArray(value.blockers) || !value.blockers.every(blocker => isPlainObject(blocker) && typeof blocker.id === 'string')) return false;
  if (!Array.isArray(value.rejections) || !Array.isArray(value.components) || !Array.isArray(value.risks)) return false;
  return true;
}

export type OutcomeStatus = 'pending' | 'observed' | 'unavailable' | 'missed';
export type StoredSignalRow = {
  id: string; address: string; pair: string; symbol: string; modelVersion: string; state: string;
  score: number; opportunity: boolean; detectedAt: number; detectedPrice: number;
  snapshot: CandidateSnapshot; assessment: Assessment;
};
export type StoredOutcomeRow = {signalId: string; horizon: string; status: OutcomeStatus; dueAt: number; observedAt: number | null; price: number | null; liquidity: number | null};

// Signals are read in fixed-size pages ordered by (detected_at, id) - a stable keyset cursor, never an
// OFFSET, so a page boundary is unaffected by rows inserted or settled between pages (an OFFSET page can
// skip or repeat rows when the underlying order changes mid-read; a keyset cursor cannot, because it
// names the last row actually seen rather than a position). Signals sharing the same detected_at are
// still totally ordered (and never split incorrectly) because id is the tiebreaker in both the query and
// the cursor.
export const SIGNAL_READ_BATCH_SIZE = 500;
// A safety bound on total pages read by one call, so a single request cannot loop indefinitely against an
// unbounded table. This does not delete or archive anything (no retention policy exists); once stored
// history exceeds SIGNAL_READ_BATCH_SIZE * MAX_SIGNAL_READ_BATCHES rows, the read stops and reports
// `truncated: true` rather than silently reading forever or running out of memory.
export const MAX_SIGNAL_READ_BATCHES = 40;
// Outcome lookups are batched by signal id, well under D1's bound statement parameter/payload limits, so
// one read never binds every signal id ever recorded into a single json_each(?) value.
export const OUTCOME_ID_BATCH_SIZE = 200;

type SignalRow = {id: string; address: string; pair: string; symbol: string; model_version: string; state: string; score: number; opportunity: number; detected_at: number; detected_price: number; snapshot: string; assessment: string};
type OutcomeRow = {signal_id: string; horizon: string; status: string; due_at: number; observed_at: number | null; price: number | null; liquidity: number | null};

// Every stored signal and its outcomes, for read-only backtesting/calibration (lib/goldmine/backtest.ts).
// Unlike readTracking (last 50 signals, current-model-version stats only), this reads every signal ever
// recorded, across every model version, so per-version and full-history analysis is possible. A row whose
// stored snapshot or assessment JSON is missing, corrupt, or structurally not a real CandidateSnapshot/
// Assessment (isValidStoredSnapshot/isValidStoredAssessment) is skipped - counted in `skipped`, never
// guessed at, and never crashes the read for every other row. Reads are paginated in bounded batches
// (SIGNAL_READ_BATCH_SIZE, capped at MAX_SIGNAL_READ_BATCHES pages; see their comments) and outcome
// lookups are batched by id (OUTCOME_ID_BATCH_SIZE), so this never issues one unbounded query. This
// performs no writes; a genuine storage failure (a rejected query) propagates to the caller rather than
// being counted as a malformed row.
export async function readAllSignalsWithOutcomes(database: D1Database, options: {signalBatchSize?: number; maxSignalBatches?: number; outcomeIdBatchSize?: number} = {}): Promise<{signals: StoredSignalRow[]; outcomes: StoredOutcomeRow[]; skipped: number; truncated: boolean}> {
  const signalBatchSize = options.signalBatchSize ?? SIGNAL_READ_BATCH_SIZE;
  const maxSignalBatches = options.maxSignalBatches ?? MAX_SIGNAL_READ_BATCHES;
  const outcomeIdBatchSize = options.outcomeIdBatchSize ?? OUTCOME_ID_BATCH_SIZE;

  let skipped = 0;
  let truncated = false;
  const signals: StoredSignalRow[] = [];
  let cursor: {detectedAt: number; id: string} | null = null;

  for (let batch = 0; batch < maxSignalBatches; batch++) {
    const query: D1PreparedStatement = cursor
      ? database.prepare('SELECT id, address, pair, symbol, model_version, state, score, opportunity, detected_at, detected_price, snapshot, assessment FROM goldmine_signals WHERE detected_at > ? OR (detected_at = ? AND id > ?) ORDER BY detected_at, id LIMIT ?')
        .bind(cursor.detectedAt, cursor.detectedAt, cursor.id, signalBatchSize)
      : database.prepare('SELECT id, address, pair, symbol, model_version, state, score, opportunity, detected_at, detected_price, snapshot, assessment FROM goldmine_signals ORDER BY detected_at, id LIMIT ?')
        .bind(signalBatchSize);
    const rows: SignalRow[] = (await query.all<SignalRow>()).results;
    if (!rows.length) break;
    for (const row of rows) {
      const snapshot = parseSnapshot(row.snapshot);
      const assessment = parseAssessment(row.assessment);
      if (!isValidStoredSnapshot(snapshot) || !isValidStoredAssessment(assessment)) { skipped++; continue; }
      signals.push({
        id: row.id, address: row.address, pair: row.pair, symbol: row.symbol, modelVersion: row.model_version, state: row.state,
        score: row.score, opportunity: row.opportunity === 1, detectedAt: row.detected_at, detectedPrice: row.detected_price,
        snapshot, assessment,
      });
    }
    const last = rows[rows.length - 1];
    cursor = {detectedAt: last.detected_at, id: last.id};
    if (rows.length < signalBatchSize) break; // a short page is the last page
    if (batch === maxSignalBatches - 1) truncated = true; // full page on the last allowed batch: more rows may remain
  }

  const outcomes: StoredOutcomeRow[] = [];
  for (let index = 0; index < signals.length; index += outcomeIdBatchSize) {
    const ids = signals.slice(index, index + outcomeIdBatchSize).map(signal => signal.id);
    const rows = (await database.prepare('SELECT signal_id, horizon, status, due_at, observed_at, price, liquidity FROM goldmine_outcomes WHERE signal_id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(ids)).all<OutcomeRow>()).results;
    for (const row of rows) {
      outcomes.push({
        signalId: row.signal_id, horizon: row.horizon,
        status: (row.status === 'observed' || row.status === 'unavailable' || row.status === 'missed' ? row.status : 'pending') as OutcomeStatus,
        dueAt: row.due_at, observedAt: row.observed_at, price: row.price, liquidity: row.liquidity,
      });
    }
  }
  return {signals, outcomes, skipped, truncated};
}

// Recent signals with their outcomes, and per-state outcome counts for the current model version.
export async function readTracking(database: D1Database) {
  const signals = (await database.prepare('SELECT id, address, pair, symbol, model_version, state, score, opportunity, detected_at, detected_price, snapshot, assessment FROM goldmine_signals ORDER BY detected_at DESC, id LIMIT 50')
    .all<{id: string; address: string; pair: string; symbol: string; model_version: string; state: string; score: number; opportunity: number; detected_at: number; detected_price: number; snapshot: string; assessment: string}>()).results;
  const outcomes = signals.length ? (await database.prepare('SELECT signal_id, horizon, status, due_at, observed_at, price, liquidity FROM goldmine_outcomes WHERE signal_id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(signals.map(signal => signal.id))).all<{signal_id: string; horizon: string; status: string; due_at: number; observed_at: number | null; price: number | null; liquidity: number | null}>()).results : [];
  const stats = (await database.prepare("SELECT s.state AS state, o.horizon AS horizon, o.status AS status, COUNT(*) AS count, AVG(CASE WHEN o.status = 'observed' THEN o.price / s.detected_price - 1 END) AS mean_return, SUM(CASE WHEN o.status = 'observed' AND o.price > s.detected_price THEN 1 ELSE 0 END) AS positive FROM goldmine_outcomes o JOIN goldmine_signals s ON s.id = o.signal_id WHERE s.model_version = ? GROUP BY s.state, o.horizon, o.status")
    .bind(MODEL_VERSION).all<{state: string; horizon: string; status: string; count: number; mean_return: number | null; positive: number}>()).results;

  const order = HORIZONS.map(horizon => horizon.id as string);
  const byHorizon = (a: {horizon: string}, b: {horizon: string}) => order.indexOf(a.horizon) - order.indexOf(b.horizon);
  const summary = new Map<string, {state: string; horizon: string; pending: number; observed: number; unavailable: number; missed: number; meanReturnPct: number | null; positiveShare: number | null}>();
  for (const row of stats) {
    const key = `${row.state}:${row.horizon}`;
    const entry = summary.get(key) ?? {state: row.state, horizon: row.horizon, pending: 0, observed: 0, unavailable: 0, missed: 0, meanReturnPct: null, positiveShare: null};
    if (row.status === 'pending' || row.status === 'observed' || row.status === 'unavailable' || row.status === 'missed') entry[row.status] += row.count;
    if (row.status === 'observed') {
      entry.meanReturnPct = percent(row.mean_return);
      entry.positiveShare = row.count ? Number((row.positive / row.count).toFixed(4)) : null;
    }
    summary.set(key, entry);
  }

  return {
    signals: signals.map(signal => ({
      id: signal.id,
      address: signal.address,
      pair: signal.pair,
      symbol: signal.symbol,
      modelVersion: signal.model_version,
      state: signal.state,
      score: signal.score,
      opportunity: signal.opportunity === 1,
      detectedAt: new Date(signal.detected_at).toISOString(),
      detectedPrice: signal.detected_price,
      // From the snapshot recorded at detection time, never recomputed: a dashboard can show exactly
      // what safety evidence backed this signal without querying RugCheck again. Reduced to the minimal
      // client-facing shape (lib/goldmine/snapshot.ts contractSafetySummary) - never the stored facts,
      // provider score or provider risk text - and defensively parsed so a malformed or legacy-shaped
      // stored snapshot can never crash this read or be read as safe.
      contractSafety: contractSafetySummary(at(parseSnapshot(signal.snapshot), 'contractSafety')),
      assessment: JSON.parse(signal.assessment) as Assessment,
      outcomes: outcomes.filter(outcome => outcome.signal_id === signal.id).sort(byHorizon).map(outcome => ({
        horizon: outcome.horizon,
        status: outcome.status,
        dueAt: new Date(outcome.due_at).toISOString(),
        observedAt: outcome.observed_at === null ? null : new Date(outcome.observed_at).toISOString(),
        price: outcome.price,
        liquidity: outcome.liquidity,
        returnPct: outcome.status === 'observed' && outcome.price !== null ? percent(outcome.price / signal.detected_price - 1) : null,
      })),
    })),
    stats: [...summary.values()].sort((a, b) => a.state.localeCompare(b.state) || byHorizon(a, b)),
  };
}
