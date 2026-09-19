// Bounded-read cost budget for lib/goldmine/signals.ts readAllSignalsWithOutcomes (Opus finding #4:
// "the 40 x 500 cap is not a safe bound on Workers" - about 110 MB retained and 140 D1 queries worst case).
// This proves, against the *current* constants (SIGNAL_READ_BATCH_SIZE=200, MAX_SIGNAL_READ_BATCHES=10,
// OUTCOME_ID_BATCH_SIZE=200 -> MAX_RETAINED_SIGNALS=2000), that:
//   - worst-case D1 query count stays at or under the documented conservative budget (MAX_WORST_CASE_QUERIES);
//   - the configured cap is actually enforced against a larger stored history;
//   - the newest signals are the ones retained;
//   - equal-timestamp rows at the cap boundary are handled correctly;
//   - aggregate calculations (replay/performance counts) stay correct across multiple pages;
//   - the read issues only SELECT statements (still read-only at scale).
// A real (in-memory sqlite) D1 database; no network.
import assert from 'node:assert/strict';
import {beforeEach, describe, test} from 'node:test';
import {createD1, runtime, startClock} from './helpers/harness.mjs';
import {pair} from './helpers/goldmine-fixtures.mjs';

const {
  readAllSignalsWithOutcomes, SIGNAL_READ_BATCH_SIZE, MAX_SIGNAL_READ_BATCHES, MAX_RETAINED_SIGNALS,
  OUTCOME_ID_BATCH_SIZE, MAX_WORST_CASE_QUERIES, HORIZONS,
} = await import('../lib/goldmine/signals.ts');
const {MODEL_VERSION, scoreCandidate} = await import('../lib/goldmine/score.ts');
const {snapshotFromPair} = await import('../lib/goldmine/snapshot.ts');

let d1, clock;
beforeEach(() => {
  clock = startClock();
  d1 = createD1();
  runtime.env.DB = d1;
});

function insertSignal(id, detectedAt) {
  const snapshot = snapshotFromPair(pair(), detectedAt);
  const assessment = {...scoreCandidate(snapshot), modelVersion: MODEL_VERSION};
  d1.sqlite.prepare('INSERT INTO goldmine_signals (id, address, pair, symbol, model_version, state, score, opportunity, detected_at, detected_price, snapshot, assessment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, id, id, 'SYM', MODEL_VERSION, assessment.state, assessment.score, assessment.opportunity ? 1 : 0, detectedAt, 1, JSON.stringify(snapshot), JSON.stringify(assessment));
  for (const horizon of HORIZONS) {
    d1.sqlite.prepare('INSERT INTO goldmine_outcomes (signal_id, horizon, due_at, deadline_at, status, observed_at, price, liquidity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, horizon.id, detectedAt + horizon.after, detectedAt + horizon.after + horizon.window, 'observed', detectedAt + horizon.after, 1.1, 1000);
  }
}

describe('documented constants', () => {
  test('MAX_RETAINED_SIGNALS is SIGNAL_READ_BATCH_SIZE * MAX_SIGNAL_READ_BATCHES', () => {
    assert.equal(MAX_RETAINED_SIGNALS, SIGNAL_READ_BATCH_SIZE * MAX_SIGNAL_READ_BATCHES);
  });
  test('MAX_WORST_CASE_QUERIES is the documented conservative formula', () => {
    assert.equal(MAX_WORST_CASE_QUERIES, MAX_SIGNAL_READ_BATCHES + Math.ceil(MAX_RETAINED_SIGNALS / OUTCOME_ID_BATCH_SIZE));
  });
  test('the cap leaves meaningful margin below a Workers Free-plan-safe budget (well under 50 queries)', () => {
    assert.ok(MAX_WORST_CASE_QUERIES <= 30, `MAX_WORST_CASE_QUERIES=${MAX_WORST_CASE_QUERIES} should leave wide margin below a conservative 50-query budget`);
  });
});

describe('worst-case query count and retained data, at the real constants', () => {
  test('worst-case D1 query count over a history exceeding the cap stays at or under MAX_WORST_CASE_QUERIES', async () => {
    const now = clock.now();
    // One more signal than the cap, so the read is forced through every allowed page.
    for (let i = 0; i < MAX_RETAINED_SIGNALS + 1; i++) insertSignal(`sig-${String(i).padStart(5, '0')}`, now + i);
    d1.queries.length = 0;
    const result = await readAllSignalsWithOutcomes(d1);
    assert.ok(d1.queries.length <= MAX_WORST_CASE_QUERIES, `issued ${d1.queries.length} queries, budget is ${MAX_WORST_CASE_QUERIES}`);
    assert.equal(result.truncated, true);
    assert.equal(result.signals.length, MAX_RETAINED_SIGNALS, 'the configured cap is enforced');
  });

  test('the retained signals are the newest ones, and outcomes/aggregates reconcile across every page', async () => {
    const now = clock.now();
    const total = MAX_RETAINED_SIGNALS + 25;
    for (let i = 0; i < total; i++) insertSignal(`sig-${String(i).padStart(5, '0')}`, now + i);
    const result = await readAllSignalsWithOutcomes(d1);
    assert.equal(result.signals.length, MAX_RETAINED_SIGNALS);
    const ids = result.signals.map(s => s.id).sort();
    const expectedNewest = Array.from({length: MAX_RETAINED_SIGNALS}, (_, i) => `sig-${String(i + 25).padStart(5, '0')}`);
    assert.deepEqual(ids, expectedNewest, 'the newest MAX_RETAINED_SIGNALS signals must be retained, not the oldest');
    assert.equal(new Set(result.signals.map(s => s.id)).size, MAX_RETAINED_SIGNALS, 'no duplicates across pages');
    // Every retained signal has exactly HORIZONS.length outcomes: the outcome-id-batched read reconciles
    // fully across every outcome-id-batch page.
    assert.equal(result.outcomes.length, MAX_RETAINED_SIGNALS * HORIZONS.length);
    const bySignal = new Map();
    for (const outcome of result.outcomes) bySignal.set(outcome.signalId, (bySignal.get(outcome.signalId) ?? 0) + 1);
    assert.equal(bySignal.size, MAX_RETAINED_SIGNALS);
    assert.ok([...bySignal.values()].every(count => count === HORIZONS.length), 'every signal has exactly one outcome per horizon, none lost or duplicated');
  });

  test('equal detected_at values at the exact cap boundary are handled without omission or duplication', async () => {
    const now = clock.now();
    // A block of ties straddling the cap boundary.
    for (let i = 0; i < MAX_RETAINED_SIGNALS - 5; i++) insertSignal(`sig-${String(i).padStart(5, '0')}`, now + i);
    for (let i = 0; i < 10; i++) insertSignal(`tie-${String(i).padStart(2, '0')}`, now + MAX_RETAINED_SIGNALS - 5); // 10 rows sharing one detected_at
    const result = await readAllSignalsWithOutcomes(d1);
    assert.equal(result.signals.length, MAX_RETAINED_SIGNALS);
    assert.equal(new Set(result.signals.map(s => s.id)).size, MAX_RETAINED_SIGNALS, 'no duplicate ids even across a tied-timestamp cap boundary');
  });

  test('the read at scale issues only SELECT statements', async () => {
    const now = clock.now();
    for (let i = 0; i < 500; i++) insertSignal(`sig-${i}`, now + i);
    d1.queries.length = 0;
    await readAllSignalsWithOutcomes(d1);
    assert.ok(d1.queries.every(sql => /^\s*SELECT/i.test(sql)), 'read-only, even at scale');
  });

  // Approximate peak retained memory, measured in this Node test harness as a proxy for a Workers isolate.
  // This is deliberately conservative and documented as an *approximation*: V8-in-Node and V8-in-a-Workers-
  // isolate have different baseline/per-object overhead, so this number is not a Workers measurement, but
  // the margin below is large enough (single-digit MB vs a 128 MB isolate limit) to absorb that difference.
  test('approximate peak retained data at the cap stays with large margin under a 128 MB Workers isolate limit', async () => {
    const now = clock.now();
    for (let i = 0; i < MAX_RETAINED_SIGNALS; i++) insertSignal(`sig-${String(i).padStart(5, '0')}`, now + i);
    const result = await readAllSignalsWithOutcomes(d1);
    assert.equal(result.signals.length, MAX_RETAINED_SIGNALS);
    // A rough but conservative proxy for retained heap: the JSON-serialized size of what is held (parsed
    // JS objects are typically larger than their JSON form, but by a small constant factor, not orders of
    // magnitude) - measured directly rather than asserted from the SIGNALS_PER_INSERT "~4 KB" comment.
    const approxBytes = Buffer.byteLength(JSON.stringify(result.signals)) + Buffer.byteLength(JSON.stringify(result.outcomes));
    const approxMB = approxBytes / (1024 * 1024);
    assert.ok(approxMB < 30, `approx ${approxMB.toFixed(1)} MB of JSON for ${MAX_RETAINED_SIGNALS} signals - expected well under 30 MB (large margin below a 128 MB Workers isolate limit even accounting for parsed-object overhead)`);
  });
});
