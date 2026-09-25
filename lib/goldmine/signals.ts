// Goldmine signal tracking in D1. A signal records a scored candidate at detection: its snapshot, its
// assessment and the provider price at that moment. Each signal gets one outcome row per horizon,
// evaluated once, only inside that horizon's window: a check that comes too late marks the outcome
// missed instead of recording a later price as if it were the horizon's. Signals are shared market
// observations and hold no user data. Prices are provider quotes, not executable prices.
import {reportFailure} from '../diagnostics';
import {fetchJson} from '../market';
import {MODEL_VERSION, STATES, type Assessment} from './score';
import {at, contractSafetySummary, socialEvidence, WINDOWS, type CandidateSnapshot, type ContractSafety, type ContractSafetyFacts} from './snapshot';

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
// MAX_OUTCOME_BATCHES requests (150 pairs), in parallel so it stays well inside the scan lock lease
// (lib/goldmine/scan.ts SCAN_LOCK_TTL_MS).
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
// Any amount that scoring reads as a magnitude (liquidity, market cap, volume, transaction counts) can
// never be negative in reality; a negative value here is impossible data, not a small or unusual one, and
// must be rejected rather than silently fed into scoreCandidate's arithmetic.
const isNonNegativeOrNull = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
const isNonNegativeIntOrNull = (value: unknown): value is number | null => isNonNegativeOrNull(value) && (value === null || Number.isInteger(value));
const isFlow = (value: unknown): boolean => isPlainObject(value) && isNonNegativeIntOrNull(value.buys) && isNonNegativeIntOrNull(value.sells);
const everyWindow = (value: unknown, check: (window: unknown) => boolean): boolean => isPlainObject(value) && WINDOWS.every(window => check(value[window]));

const CONTRACT_SAFETY_STATUSES = ['unavailable', 'unsafe', 'verified'] as const;

// A stored contractSafety's `facts` object, when present. Every fact is independently nullable at write
// time (lib/goldmine/contract-safety.ts), so validation only constrains the type/sign of whatever is
// present, never requires every fact to be non-null.
function isValidContractSafetyFacts(value: unknown): value is ContractSafetyFacts {
  if (!isPlainObject(value)) return false;
  const boolOrNull = (v: unknown) => v === null || typeof v === 'boolean';
  const pctOrNull = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100);
  if (!boolOrNull(value.mintAuthorityRenounced) || !boolOrNull(value.freezeAuthorityRenounced) || !boolOrNull(value.rugged)) return false;
  if (!pctOrNull(value.lpLockedPct) || !pctOrNull(value.topHolderPct) || !pctOrNull(value.topHoldersPct) || !pctOrNull(value.creatorHoldingsPct)) return false;
  // The writer (lib/goldmine/contract-safety.ts extractFacts) persists both of these as
  // `numberOrNull(...)` - any finite number RugCheck reports, with no additional sign/integer
  // constraint - not the non-negative (and, for insiderNetworksDetected, non-negative-integer) shape an
  // earlier version of this validator assumed. A reader stricter than the actual writer would reject a
  // row the writer can legitimately persist (e.g. a fractional or negative graphInsidersDetected/
  // totalMarketLiquidity RugCheck happens to report); neither field is read by scoring beyond an equality
  // check against 0 (lib/goldmine/contract-safety.ts safetyChecks), so relaxing this to match the real
  // persisted contract changes no scoring behavior.
  if (!isFiniteOrNull(value.totalMarketLiquidityUsd)) return false;
  if (!isFiniteOrNull(value.insiderNetworksDetected)) return false;
  if (!isFiniteOrNull(value.providerScoreNormalized)) return false;
  if (!Array.isArray(value.providerRisks) || !value.providerRisks.every(risk => isPlainObject(risk) && typeof risk.name === 'string' && typeof risk.level === 'string' && typeof risk.description === 'string')) return false;
  return true;
}

// contractSafety is a real discriminated union (lib/goldmine/snapshot.ts), not just an object with a
// string `status`. `scoreCandidate` (lib/goldmine/score.ts:206-208) dereferences `source`/`failedChecks`
// directly for 'unsafe' and 'verified' without a further type guard - a stored row whose status claims
// 'unsafe' but omits `failedChecks` (or stores it as something other than a string[]) throws there. Every
// branch is validated by its actual required shape; any other status string is rejected outright.
function isValidContractSafety(value: unknown): value is ContractSafety {
  if (!isPlainObject(value)) return false;
  if (typeof value.status !== 'string' || !(CONTRACT_SAFETY_STATUSES as readonly string[]).includes(value.status)) return false;
  if (value.status === 'unavailable') return value.source === null;
  if (!(typeof value.source === 'string' && value.source) || typeof value.checkedAt !== 'number' || !Number.isFinite(value.checkedAt)) return false;
  if (!isValidContractSafetyFacts(value.facts)) return false;
  if (value.status === 'unsafe') return Array.isArray(value.failedChecks) && value.failedChecks.length > 0 && value.failedChecks.every(check => typeof check === 'string');
  return true; // 'verified'
}

// Structural validation of a stored, parsed snapshot value against the fields replay (scoreCandidate) and
// reporting actually read. This is not a full schema validator: it rejects the shapes a real
// CandidateSnapshot can never be (an array, `{}`, `null`, a wrong primitive type, a missing nested field,
// an impossible negative amount, an unrecognized contractSafety status or a status-specific field of the
// wrong shape) without re-deriving every rule snapshot.ts already enforces at write time.
// `typeof value === 'object'` alone is not enough - `[]`, `{}` and a partially-shaped object all pass
// that check but would throw or silently misbehave once scoreCandidate reads into them; a bare
// `typeof status === 'string'` check on contractSafety is not enough either - `{status: 'unsafe'}` with no
// `failedChecks` passes that check and throws inside scoreCandidate's safetyRisk component.
export function isValidStoredSnapshot(value: unknown): value is CandidateSnapshot {
  if (!isPlainObject(value)) return false;
  if (typeof value.address !== 'string' || !value.address) return false;
  if (typeof value.pair !== 'string' || !value.pair) return false;
  if (typeof value.symbol !== 'string') return false;
  if (typeof value.observedAt !== 'number' || !Number.isFinite(value.observedAt)) return false;
  if (typeof value.promoted !== 'boolean') return false;
  if (value.priceUsd !== null && (typeof value.priceUsd !== 'number' || !Number.isFinite(value.priceUsd) || value.priceUsd <= 0)) return false;
  if (!isNonNegativeOrNull(value.liquidityUsd) || !isNonNegativeOrNull(value.marketCapUsd) || !isNonNegativeOrNull(value.fdvUsd) || !isNonNegativeOrNull(value.ageMinutes)) return false;
  if (!everyWindow(value.volumeUsd, isNonNegativeOrNull)) return false;
  if (!everyWindow(value.priceChangePct, v => isFiniteOrNull(v) && (v === null || v >= -100))) return false;
  if (!everyWindow(value.txns, isFlow)) return false;
  if (!isPlainObject(value.links) || !isNonNegativeIntOrNull(value.links.websites) || value.links.websites === null || !isNonNegativeIntOrNull(value.links.socials) || value.links.socials === null) return false;
  if (!isValidContractSafety(value.contractSafety)) return false;
  return true;
}

const KNOWN_STATES: readonly string[] = STATES;
// Assessment score is the sum of every component's points, each already clamped to its own max
// (lib/goldmine/score.ts liquidityVolume/volumeAcceleration/buyerPressure/ageValuation/socialMomentum/
// safetyRisk: 20+20+20+15+10+15 = 100), so a real assessment's score can never fall outside [0, 100].
const MAX_SCORE = 100;

// Structural validation of a stored, parsed assessment value against the fields replay and reporting
// actually read (modelVersion, state, score, opportunity, blockers[].id, address/pair/symbol for display).
// Same rationale as isValidStoredSnapshot: reject arrays, `{}`, `null`, wrong-typed/missing fields, an
// unrecognized `state` (state is a closed enum - STATES - not an arbitrary string) and a score outside the
// domain scoreCandidate can ever produce.
export function isValidStoredAssessment(value: unknown): value is Assessment {
  if (!isPlainObject(value)) return false;
  if (typeof value.modelVersion !== 'string' || !value.modelVersion) return false;
  if (typeof value.address !== 'string' || typeof value.pair !== 'string' || typeof value.symbol !== 'string') return false;
  if (typeof value.state !== 'string' || !KNOWN_STATES.includes(value.state)) return false;
  if (typeof value.score !== 'number' || !Number.isFinite(value.score) || value.score < 0 || value.score > MAX_SCORE) return false;
  if (typeof value.opportunity !== 'boolean') return false;
  const isGate = (gate: unknown) => isPlainObject(gate) && typeof gate.id === 'string' && gate.id.length > 0 && typeof gate.message === 'string';
  if (!Array.isArray(value.blockers) || !value.blockers.every(isGate)) return false;
  if (!Array.isArray(value.rejections) || !value.rejections.every(isGate)) return false;
  if (!Array.isArray(value.components) || !Array.isArray(value.risks)) return false;
  return true;
}

export const OUTCOME_STATUSES = ['pending', 'observed', 'unavailable', 'missed'] as const;
const KNOWN_HORIZONS: readonly string[] = HORIZONS.map(h => h.id);

// Structural validation of a stored, parsed outcome row against exactly the shape evaluateOutcomes ever
// writes (lib/goldmine/signals.ts): a known status, a known horizon, and status-appropriate nullability
// of observed_at/price/liquidity. An unrecognized status string (a corrupt or hand-edited row) must never
// be reinterpreted as 'pending' - that would silently inflate pending coverage and hide the corruption.
export function isValidStoredOutcomeRow(row: {horizon: string; status: string; observed_at: number | null; price: number | null; liquidity: number | null}): boolean {
  if (!KNOWN_HORIZONS.includes(row.horizon)) return false;
  if (!(OUTCOME_STATUSES as readonly string[]).includes(row.status)) return false;
  if (row.status === 'observed') {
    if (typeof row.observed_at !== 'number' || !Number.isFinite(row.observed_at)) return false;
    if (typeof row.price !== 'number' || !Number.isFinite(row.price) || row.price <= 0) return false;
    if (row.liquidity !== null && (typeof row.liquidity !== 'number' || !Number.isFinite(row.liquidity) || row.liquidity < 0)) return false;
    return true;
  }
  if (row.status === 'unavailable') {
    // evaluateOutcomes always stamps observed_at when a batch responds, even when no usable price/pool
    // was found (that is exactly what 'unavailable' records); price and liquidity are always null.
    return typeof row.observed_at === 'number' && Number.isFinite(row.observed_at) && row.price === null && row.liquidity === null;
  }
  // 'pending' and 'missed' never carry an observation.
  return row.observed_at === null && row.price === null && row.liquidity === null;
}

export type OutcomeStatus = 'pending' | 'observed' | 'unavailable' | 'missed';
export type StoredSignalRow = {
  id: string; address: string; pair: string; symbol: string; modelVersion: string; state: string;
  score: number; opportunity: boolean; detectedAt: number; detectedPrice: number;
  snapshot: CandidateSnapshot; assessment: Assessment;
};
export type StoredOutcomeRow = {signalId: string; horizon: string; status: OutcomeStatus; dueAt: number; observedAt: number | null; price: number | null; liquidity: number | null};

// Signals are read in fixed-size pages ordered by (detected_at, id) DESCENDING - a stable keyset cursor,
// never an OFFSET, so a page boundary is unaffected by rows inserted or settled between pages (an OFFSET
// page can skip or repeat rows when the underlying order changes mid-read; a keyset cursor cannot, because
// it names the last row actually seen rather than a position). Descending order matters whenever the read
// is bounded and truncates: it must keep the newest signals (the ones still relevant to calibration's
// chronological split and to any operator debugging recent behavior), never silently drop them in favor of
// the oldest rows still fitting inside the cap. Signals sharing the same detected_at are still totally
// ordered (and never split incorrectly) because id is the tiebreaker in both the query and the cursor.
// `signals` is reversed back to ascending order (normalizeAscending below) before it is returned, so every
// consumer (replay, performanceReport, calibrationSweep's chronological split) sees the same chronological
// order it always has.
export const SIGNAL_READ_BATCH_SIZE = 200;
// A safety bound on total pages read by one call, so a single request cannot loop indefinitely against an
// unbounded table and so worst-case memory/query cost stays bounded and documented (see
// MAX_RETAINED_SIGNALS and the query-count comment on readAllSignalsWithOutcomes below). This does not
// delete or archive anything (no retention policy exists); once stored history exceeds
// SIGNAL_READ_BATCH_SIZE * MAX_SIGNAL_READ_BATCHES rows, the read stops (keeping the newest rows) and
// reports `truncated: true` rather than silently reading forever, an unbounded number of D1 queries, or an
// unbounded amount of retained JSON.
export const MAX_SIGNAL_READ_BATCHES = 10;
// The largest number of signal rows (each holding a full snapshot + assessment, ~4 KB of JSON per the
// SIGNALS_PER_INSERT comment above) any one call ever holds in memory at once. At the current constants
// (200 * 10) that is 2,000 rows. tests/goldmine-backtest-limits.test.mjs asserts the deterministic,
// CI-safe proxy for this: the serialized JSON text size of the returned signals+outcomes stays well under
// 30 MB (that test measures JSON text size, not retained heap - see its own comment). A separate, one-off
// diagnostic Node --expose-gc heap measurement (not committed as a test, not run in CI) observed
// approximately 16.4 MB of retained heap for a comparable dataset. Neither number is a measurement of a
// Workers isolate's actual V8 memory use - Node's V8 and a Workers isolate's V8 differ in baseline and
// per-object overhead - so neither is formal proof of peak Workers memory; both leave a wide margin below
// a Workers isolate's 128 MB limit, which is the basis for treating this cap as safe, not an exact bound.
export const MAX_RETAINED_SIGNALS = SIGNAL_READ_BATCH_SIZE * MAX_SIGNAL_READ_BATCHES;
// Outcome lookups are batched by signal id, well under D1's bound statement parameter/payload limits, so
// one read never binds every signal id ever recorded into a single json_each(?) value.
export const OUTCOME_ID_BATCH_SIZE = 200;
// Worst-case D1 query count for one readAllSignalsWithOutcomes call, at the constants above:
//   MAX_SIGNAL_READ_BATCHES (signal pages, at most 10)
//   + ceil(MAX_RETAINED_SIGNALS / OUTCOME_ID_BATCH_SIZE) (outcome id batches, at most 10)
//   = 20 queries, independent of how much history is actually stored.
// This is a conservative, documented budget chosen without assuming a paid Cloudflare plan - it leaves
// wide margin below any per-invocation D1/subrequest ceiling a Workers Free plan could plausibly impose,
// and is verified directly in tests/goldmine-backtest-limits.test.mjs (worst-case query count assertion).
export const MAX_WORST_CASE_QUERIES = MAX_SIGNAL_READ_BATCHES + Math.ceil(MAX_RETAINED_SIGNALS / OUTCOME_ID_BATCH_SIZE);

type SignalRow = {id: string; address: string; pair: string; symbol: string; model_version: string; state: string; score: number; opportunity: number; detected_at: number; detected_price: number; snapshot: string; assessment: string};
type OutcomeRow = {signal_id: string; horizon: string; status: string; due_at: number; observed_at: number | null; price: number | null; liquidity: number | null};

// Every stored signal and its outcomes, for read-only backtesting/calibration (lib/goldmine/backtest.ts).
// Unlike readTracking (last 50 signals, current-model-version stats only), this reads every signal up to
// the bound above, across every model version, so per-version and full-history analysis is possible.
//
// A row is skipped (never entered into `signals`, counted in `skippedMalformedSignals`) when any of the
// following holds, so one unexpected historical row can never crash the read for every other row or enter
// replay/calibration with data scoreCandidate cannot safely process:
//   - its stored snapshot or assessment JSON is missing, corrupt, or structurally not a real
//     CandidateSnapshot/Assessment (isValidStoredSnapshot/isValidStoredAssessment, including a rejected
//     contractSafety shape, an unknown assessment `state`, a non-finite/negative amount, or a score outside
//     [0, 100]);
//   - the row's own `model_version` or `state` column disagrees with the parsed assessment's `modelVersion`/
//     `state` - replay and calibration read the column for filtering/grouping but the assessment for
//     content, so a mismatch here would silently let one thing be replayed/reported as if it were the
//     other; a mismatched row is malformed data, not read under either interpretation;
//   - `detected_price` is not a finite, positive number (every return computation divides by it).
export async function readAllSignalsWithOutcomes(database: D1Database, options: {signalBatchSize?: number; maxSignalBatches?: number; outcomeIdBatchSize?: number} = {}): Promise<{signals: StoredSignalRow[]; outcomes: StoredOutcomeRow[]; skippedMalformedSignals: number; skippedMalformedOutcomes: number; truncated: boolean}> {
  const signalBatchSize = options.signalBatchSize ?? SIGNAL_READ_BATCH_SIZE;
  const maxSignalBatches = options.maxSignalBatches ?? MAX_SIGNAL_READ_BATCHES;
  const outcomeIdBatchSize = options.outcomeIdBatchSize ?? OUTCOME_ID_BATCH_SIZE;

  let skippedMalformedSignals = 0;
  let truncated = false;
  const signals: StoredSignalRow[] = []; // collected newest-first; reversed to ascending before return
  let cursor: {detectedAt: number; id: string} | null = null;

  for (let batch = 0; batch < maxSignalBatches; batch++) {
    // LIMIT signalBatchSize + 1 is a lookahead: fetching one extra row is the only reliable way to tell
    // "the history ends exactly at the cap" (no extra row comes back: truncated must stay false) apart
    // from "the cap falls mid-history" (an extra row comes back: there is strictly more data beyond what
    // this call will keep). Comparing rows.length to signalBatchSize without that lookahead cannot make
    // this distinction, which is exactly how an earlier version of this function misreported an
    // exact-cap-sized history as truncated.
    const lookahead = signalBatchSize + 1;
    const query: D1PreparedStatement = cursor
      ? database.prepare('SELECT id, address, pair, symbol, model_version, state, score, opportunity, detected_at, detected_price, snapshot, assessment FROM goldmine_signals WHERE detected_at < ? OR (detected_at = ? AND id < ?) ORDER BY detected_at DESC, id DESC LIMIT ?')
        .bind(cursor.detectedAt, cursor.detectedAt, cursor.id, lookahead)
      : database.prepare('SELECT id, address, pair, symbol, model_version, state, score, opportunity, detected_at, detected_price, snapshot, assessment FROM goldmine_signals ORDER BY detected_at DESC, id DESC LIMIT ?')
        .bind(lookahead);
    const fetched: SignalRow[] = (await query.all<SignalRow>()).results;
    if (!fetched.length) break;
    const hasMore = fetched.length > signalBatchSize;
    const rows = hasMore ? fetched.slice(0, signalBatchSize) : fetched; // drop the lookahead row itself
    for (const row of rows) {
      const snapshot = parseSnapshot(row.snapshot);
      const assessment = parseAssessment(row.assessment);
      if (!isValidStoredSnapshot(snapshot) || !isValidStoredAssessment(assessment)) { skippedMalformedSignals++; continue; }
      if (row.model_version !== assessment.modelVersion || row.state !== assessment.state) { skippedMalformedSignals++; continue; }
      if (typeof row.detected_price !== 'number' || !Number.isFinite(row.detected_price) || row.detected_price <= 0) { skippedMalformedSignals++; continue; }
      signals.push({
        id: row.id, address: row.address, pair: row.pair, symbol: row.symbol, modelVersion: row.model_version, state: row.state,
        score: row.score, opportunity: row.opportunity === 1, detectedAt: row.detected_at, detectedPrice: row.detected_price,
        snapshot, assessment,
      });
    }
    const last = rows[rows.length - 1];
    cursor = {detectedAt: last.detected_at, id: last.id};
    if (!hasMore) break; // nothing past this page: the read is complete, whatever the page count so far
    if (batch === maxSignalBatches - 1) truncated = true; // more rows exist beyond the allowed page budget
  }
  signals.reverse(); // newest-first collection order -> ascending chronological order for every consumer

  const outcomes: StoredOutcomeRow[] = [];
  let skippedMalformedOutcomes = 0;
  for (let index = 0; index < signals.length; index += outcomeIdBatchSize) {
    const ids = signals.slice(index, index + outcomeIdBatchSize).map(signal => signal.id);
    const rows = (await database.prepare('SELECT signal_id, horizon, status, due_at, observed_at, price, liquidity FROM goldmine_outcomes WHERE signal_id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(ids)).all<OutcomeRow>()).results;
    for (const row of rows) {
      // An outcome row whose status/horizon/nullability does not match exactly what evaluateOutcomes ever
      // writes is malformed data, not a value to guess at - it is excluded from both the returned list and
      // every downstream coverage/return computation, and counted separately so it is never mistaken for
      // (or silently folded into) 'pending' coverage.
      if (!isValidStoredOutcomeRow(row)) { skippedMalformedOutcomes++; continue; }
      outcomes.push({
        signalId: row.signal_id, horizon: row.horizon, status: row.status as OutcomeStatus,
        dueAt: row.due_at, observedAt: row.observed_at, price: row.price, liquidity: row.liquidity,
      });
    }
  }
  return {signals, outcomes, skippedMalformedSignals, skippedMalformedOutcomes, truncated};
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

// One batch of recorded signals: everything one scan wrote. `recordSignals()` binds a single
// `detectedAt` for the whole batch, so the rows carrying MAX(detected_at) are exactly what the most
// recent scan that recorded anything recorded - derived from existing columns, needing no new table,
// column or migration.
export type LatestBatch = {detectedAt: string; signalCount: number; opportunityCount: number; byState: {state: string; count: number}[]};

// COUNT/SUM come back from D1 and from Turso as driver-shaped values, and one malformed or legacy row
// must not be able to turn a count into NaN, a negative or a fraction on a dashboard.
const wholeCount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

// Reads the most recent recorded batch, for the dashboard's "most recent recorded signals" line
// (lib/goldmine/dashboard-view.ts, app/goldmine-panel.tsx). Read-only and bounded: one grouped query
// over the `goldmine_signals_detected_at_idx` index, returning at most one row per state.
//
// What this is, exactly - and what the dashboard must therefore not claim it is:
//   - It is NOT "when the last scan ran". A scan that records nothing still ran: every candidate may
//     already be recorded in the same state and six-hour bucket (signalId()), or discovery may have
//     failed and returned `provider_unavailable`. In both cases `detected_at` does not advance.
//   - It does NOT say who scanned. The interactive POST /api/goldmine and the scheduled route
//     (app/api/goldmine/scheduled/route.ts) run the same pipeline and write identical rows; nothing
//     stored distinguishes them.
// Both limits are stated in the UI copy rather than papered over, because the question this answers
// for the owner - "is anything still scanning, and what did it see?" - is only useful while its exact
// meaning stays intact.
//
// Model version is deliberately not filtered here, unlike readTracking()'s statistics: this reports
// what was last written, whatever model wrote it, so a version change can never make the dashboard
// look as though scanning had stopped.
export async function readLatestBatch(database: D1Database): Promise<LatestBatch | null> {
  // An empty table makes the subquery NULL, which `detected_at = NULL` never matches, so this returns
  // no rows and the caller gets null - the "nothing recorded yet" case, not an error.
  const rows = (await database.prepare('SELECT detected_at, state, COUNT(*) AS count, SUM(opportunity) AS opportunities FROM goldmine_signals WHERE detected_at = (SELECT MAX(detected_at) FROM goldmine_signals) GROUP BY detected_at, state')
    .all<{detected_at: number; state: string; count: number; opportunities: number | null}>()).results;
  if (!rows.length) return null;
  const detectedAt = rows[0].detected_at;
  if (typeof detectedAt !== 'number' || !Number.isFinite(detectedAt)) return null;

  const order = STATES.map(state => state as string);
  // Known states in the model's own order first; anything else (a legacy or unexpected stored state)
  // is kept and sorted after them rather than dropped, so a count shown here always adds up.
  const byState = rows
    .map(row => ({state: String(row.state), count: wholeCount(row.count)}))
    .filter(entry => entry.count > 0)
    .sort((a, b) => {
      const rankA = order.indexOf(a.state), rankB = order.indexOf(b.state);
      if (rankA !== rankB) return (rankA < 0 ? order.length : rankA) - (rankB < 0 ? order.length : rankB);
      return a.state.localeCompare(b.state);
    });
  return {
    detectedAt: new Date(detectedAt).toISOString(),
    signalCount: byState.reduce((total, entry) => total + entry.count, 0),
    opportunityCount: rows.reduce((total, row) => total + wholeCount(row.opportunities), 0),
    byState,
  };
}
