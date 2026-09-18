// Goldmine signal tracking in D1. A signal records a scored candidate at detection: its snapshot, its
// assessment and the provider price at that moment. Each signal gets one outcome row per horizon,
// evaluated once, only inside that horizon's window: a check that comes too late marks the outcome
// missed instead of recording a later price as if it were the horizon's. Signals are shared market
// observations and hold no user data. Prices are provider quotes, not executable prices.
import {reportFailure} from '../diagnostics';
import {fetchJson} from '../market';
import {MODEL_VERSION, type Assessment} from './score';
import {at, socialEvidence, type CandidateSnapshot} from './snapshot';

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
// DEX Screener's pairs endpoint accepts up to 30 pair addresses.
export const MAX_OUTCOME_PAIRS = 30;

export type Scored = {snapshot: CandidateSnapshot; assessment: Assessment};
export type OutcomeRun = {provider: 'not_needed' | 'ok' | 'unavailable'; observed: number; unavailable: number; missed: number};

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
  if (!rows.length) return 0;
  const inserted = await database.prepare("INSERT OR IGNORE INTO goldmine_signals (id, address, pair, symbol, model_version, state, score, opportunity, detected_at, detected_price, snapshot, assessment) SELECT json_extract(value, '$.id'), json_extract(value, '$.address'), json_extract(value, '$.pair'), json_extract(value, '$.symbol'), json_extract(value, '$.modelVersion'), json_extract(value, '$.state'), json_extract(value, '$.score'), json_extract(value, '$.opportunity'), json_extract(value, '$.detectedAt'), json_extract(value, '$.detectedPrice'), json_extract(value, '$.snapshot'), json_extract(value, '$.assessment') FROM json_each(?)")
    .bind(JSON.stringify(rows)).run();
  const horizons = Object.fromEntries(HORIZONS.map(({id, after, window}) => [id, {after, window}]));
  await database.prepare("INSERT OR IGNORE INTO goldmine_outcomes (signal_id, horizon, due_at, deadline_at) SELECT s.id, h.key, s.detected_at + json_extract(h.value, '$.after'), s.detected_at + json_extract(h.value, '$.after') + json_extract(h.value, '$.window') FROM goldmine_signals s JOIN json_each(?) h WHERE s.id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(horizons), JSON.stringify(rows.map(row => row.id))).run();
  return inserted.meta.changes ?? 0;
}

// Settles due outcomes. Pending outcomes whose window has closed become missed. For the rest, the recorded
// pool is read once: a valid price is observed; a successful response without the pool or its price is
// unavailable (possibly delisted). A provider failure leaves them pending for the next scan.
export async function evaluateOutcomes(database: D1Database, now: number): Promise<OutcomeRun> {
  const missed = (await database.prepare("UPDATE goldmine_outcomes SET status = 'missed' WHERE status = 'pending' AND deadline_at < ?").bind(now).run()).meta.changes ?? 0;
  const due = (await database.prepare("SELECT s.pair AS pair, s.address AS address FROM goldmine_outcomes o JOIN goldmine_signals s ON s.id = o.signal_id WHERE o.status = 'pending' AND o.due_at <= ? GROUP BY s.pair, s.address ORDER BY MIN(o.due_at), s.pair LIMIT 30")
    .bind(now).all<{pair: string; address: string}>()).results;
  const run: OutcomeRun = {provider: 'not_needed', observed: 0, unavailable: 0, missed};
  if (!due.length) return run;

  let pools: unknown[];
  try {
    const response = await fetchJson('https://api.dexscreener.com/latest/dex/pairs/solana/' + [...new Set(due.map(row => row.pair))].slice(0, MAX_OUTCOME_PAIRS).join(','), 10000);
    const listed = at(response, 'pairs');
    pools = Array.isArray(listed) ? listed : [];
  } catch (error) {
    reportFailure('goldmine', 'outcome-provider', error, 'warn');
    return {...run, provider: 'unavailable'};
  }
  run.provider = 'ok';
  for (const {pair, address} of due) {
    const pool = pools.find(p => at(p, 'chainId') === 'solana' && at(p, 'pairAddress') === pair && at(p, 'baseToken', 'address') === address);
    const price = Number(at(pool, 'priceUsd') ?? NaN);
    const liquidity = Number(at(pool, 'liquidity', 'usd') ?? NaN);
    const valid = Number.isFinite(price) && price > 0;
    const result = await database.prepare("UPDATE goldmine_outcomes SET status = ?, observed_at = ?, price = ?, liquidity = ? WHERE status = 'pending' AND due_at <= ? AND deadline_at >= ? AND signal_id IN (SELECT id FROM goldmine_signals WHERE pair = ? AND address = ?)")
      .bind(valid ? 'observed' : 'unavailable', now, valid ? price : null, valid && Number.isFinite(liquidity) && liquidity >= 0 ? liquidity : null, now, now, pair, address).run();
    run[valid ? 'observed' : 'unavailable'] += result.meta.changes ?? 0;
  }
  return run;
}

const percent = (value: number | null) => value === null ? null : Number((value * 100).toFixed(2));

// Recent signals with their outcomes, and per-state outcome counts for the current model version.
export async function readTracking(database: D1Database) {
  const signals = (await database.prepare('SELECT id, address, pair, symbol, model_version, state, score, opportunity, detected_at, detected_price, assessment FROM goldmine_signals ORDER BY detected_at DESC, id LIMIT 50')
    .all<{id: string; address: string; pair: string; symbol: string; model_version: string; state: string; score: number; opportunity: number; detected_at: number; detected_price: number; assessment: string}>()).results;
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
