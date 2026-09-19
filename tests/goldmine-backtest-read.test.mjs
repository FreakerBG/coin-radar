// lib/goldmine/signals.ts readAllSignalsWithOutcomes: structural validation of stored snapshot/assessment
// JSON (isValidStoredSnapshot/isValidStoredAssessment) and bounded, keyset-paginated batching over
// goldmine_signals/goldmine_outcomes. No provider call, no writes - a real (in-memory sqlite) D1 database.
import assert from 'node:assert/strict';
import {beforeEach, describe, test} from 'node:test';
import {createD1, runtime, startClock} from './helpers/harness.mjs';
import {pair} from './helpers/goldmine-fixtures.mjs';

const {isValidStoredSnapshot, isValidStoredAssessment, readAllSignalsWithOutcomes} = await import('../lib/goldmine/signals.ts');
const {MODEL_VERSION, scoreCandidate} = await import('../lib/goldmine/score.ts');
const {snapshotFromPair} = await import('../lib/goldmine/snapshot.ts');

const MINUTE = 60000;
const validSnapshot = () => snapshotFromPair(pair(), Date.UTC(2026, 8, 18, 12));
const validAssessment = () => scoreCandidate(validSnapshot());

describe('isValidStoredSnapshot', () => {
  test('a real snapshot is valid', () => assert.equal(isValidStoredSnapshot(validSnapshot()), true));
  for (const bad of [[], {}, null, 'x', 42, true]) {
    test(`rejects ${JSON.stringify(bad)}`, () => assert.equal(isValidStoredSnapshot(bad), false));
  }
  test('rejects a missing nested field (txns.h1 absent)', () => {
    const snapshot = validSnapshot();
    const rest = {...snapshot.txns};
    delete rest.h1;
    assert.equal(isValidStoredSnapshot({...snapshot, txns: rest}), false);
  });
  test('rejects a wrong primitive type (address as a number)', () => {
    assert.equal(isValidStoredSnapshot({...validSnapshot(), address: 12345}), false);
  });
  test('rejects volumeUsd as an array (typeof array is "object" but must still be rejected)', () => {
    assert.equal(isValidStoredSnapshot({...validSnapshot(), volumeUsd: []}), false);
  });
  test('rejects contractSafety missing its status field', () => {
    assert.equal(isValidStoredSnapshot({...validSnapshot(), contractSafety: {}}), false);
  });
});

describe('isValidStoredAssessment', () => {
  test('a real assessment is valid', () => assert.equal(isValidStoredAssessment(validAssessment()), true));
  for (const bad of [[], {}, null, 'x', 42, true]) {
    test(`rejects ${JSON.stringify(bad)}`, () => assert.equal(isValidStoredAssessment(bad), false));
  }
  test('rejects blockers as a non-array', () => {
    assert.equal(isValidStoredAssessment({...validAssessment(), blockers: {}}), false);
  });
  test('rejects a blocker missing its id', () => {
    assert.equal(isValidStoredAssessment({...validAssessment(), blockers: [{message: 'x'}]}), false);
  });
  test('rejects a non-boolean opportunity', () => {
    assert.equal(isValidStoredAssessment({...validAssessment(), opportunity: 'yes'}), false);
  });
});

let d1, clock;
function insertSignal({id, detectedAt, modelVersion = MODEL_VERSION, snapshotJson, assessmentJson}) {
  const snapshot = validSnapshot();
  const assessment = {...scoreCandidate(snapshot), modelVersion};
  d1.sqlite.prepare('INSERT INTO goldmine_signals (id, address, pair, symbol, model_version, state, score, opportunity, detected_at, detected_price, snapshot, assessment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, id, id, 'SYM', modelVersion, assessment.state, assessment.score, assessment.opportunity ? 1 : 0, detectedAt, 1,
      snapshotJson !== undefined ? snapshotJson : JSON.stringify(snapshot), assessmentJson !== undefined ? assessmentJson : JSON.stringify(assessment));
}
function insertOutcome(signalId, horizon, {status = 'pending', dueAt, price = null} = {}) {
  d1.sqlite.prepare('INSERT INTO goldmine_outcomes (signal_id, horizon, due_at, deadline_at, status, observed_at, price, liquidity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(signalId, horizon, dueAt, dueAt + MINUTE, status, status === 'observed' ? dueAt : null, price, status === 'observed' ? 1000 : null);
}

beforeEach(() => {
  clock = startClock();
  d1 = createD1();
  runtime.env.DB = d1;
});

describe('readAllSignalsWithOutcomes: malformed rows', () => {
  test('[], {}, null and incomplete/wrong-typed rows are all skipped, not crashed on', async () => {
    const now = clock.now();
    insertSignal({id: 'array', detectedAt: now, snapshotJson: '[]'});
    insertSignal({id: 'empty-obj', detectedAt: now + 1, snapshotJson: '{}'});
    insertSignal({id: 'null-json', detectedAt: now + 2, snapshotJson: 'null'});
    insertSignal({id: 'missing-nested', detectedAt: now + 3, snapshotJson: JSON.stringify({...validSnapshot(), txns: {}})});
    insertSignal({id: 'wrong-type', detectedAt: now + 4, snapshotJson: JSON.stringify({...validSnapshot(), address: 1})});
    insertSignal({id: 'bad-assessment', detectedAt: now + 5, assessmentJson: '[]'});
    insertSignal({id: 'not-json', detectedAt: now + 6, snapshotJson: '{not valid'});
    const valid = validSnapshot();
    insertSignal({id: 'ok', detectedAt: now + 7, snapshotJson: JSON.stringify(valid), assessmentJson: JSON.stringify({...scoreCandidate(valid), modelVersion: MODEL_VERSION})});

    const result = await readAllSignalsWithOutcomes(d1);
    assert.equal(result.skipped, 7);
    assert.equal(result.signals.length, 1);
    assert.equal(result.signals[0].id, 'ok');
    assert.equal(result.truncated, false);
  });

  test('valid and invalid rows mixed keep every valid row and count skipped accurately', async () => {
    const now = clock.now();
    for (let i = 0; i < 5; i++) insertSignal({id: `ok-${i}`, detectedAt: now + i});
    for (let i = 0; i < 3; i++) insertSignal({id: `bad-${i}`, detectedAt: now + 10 + i, snapshotJson: '{}'});
    const result = await readAllSignalsWithOutcomes(d1);
    assert.equal(result.signals.length, 5);
    assert.equal(result.skipped, 3);
  });
});

describe('readAllSignalsWithOutcomes: bounded, keyset-paginated batching', () => {
  test('reads more signals than one batch, in full, with no duplicates or omissions', async () => {
    const now = clock.now();
    for (let i = 0; i < 25; i++) insertSignal({id: `sig-${String(i).padStart(2, '0')}`, detectedAt: now + i});
    const result = await readAllSignalsWithOutcomes(d1, {signalBatchSize: 7});
    assert.equal(result.signals.length, 25);
    const ids = result.signals.map(s => s.id);
    assert.equal(new Set(ids).size, 25, 'no duplicate signal across batch boundaries');
    assert.deepEqual([...ids].sort(), ids.map((_, i) => `sig-${String(i).padStart(2, '0')}`), 'nothing omitted');
    assert.equal(result.truncated, false);
  });

  test('signals sharing the same detection timestamp are all read exactly once, however a batch boundary falls', async () => {
    const now = clock.now();
    for (let i = 0; i < 10; i++) insertSignal({id: `tie-${String(i).padStart(2, '0')}`, detectedAt: now}); // all identical detected_at
    const result = await readAllSignalsWithOutcomes(d1, {signalBatchSize: 3});
    assert.equal(result.signals.length, 10);
    assert.equal(new Set(result.signals.map(s => s.id)).size, 10);
  });

  test('outcomes are correctly gathered even when distributed across different outcome id batches', async () => {
    const now = clock.now();
    for (let i = 0; i < 12; i++) {
      insertSignal({id: `sig-${i}`, detectedAt: now + i});
      insertOutcome(`sig-${i}`, '15m', {status: 'observed', dueAt: now + i, price: 1.1});
    }
    const result = await readAllSignalsWithOutcomes(d1, {signalBatchSize: 5, outcomeIdBatchSize: 4});
    assert.equal(result.outcomes.length, 12);
    assert.equal(new Set(result.outcomes.map(o => o.signalId)).size, 12, 'every signal has exactly one 15m outcome, none lost or duplicated across id batches');
  });

  test('malformed rows spanning multiple signal batches are all skipped and counted, valid rows across the same batches are preserved', async () => {
    const now = clock.now();
    for (let i = 0; i < 20; i++) {
      if (i % 3 === 0) insertSignal({id: `bad-${i}`, detectedAt: now + i, snapshotJson: '{}'});
      else insertSignal({id: `ok-${i}`, detectedAt: now + i});
    }
    const result = await readAllSignalsWithOutcomes(d1, {signalBatchSize: 4});
    const expectedBad = Array.from({length: 20}, (_, i) => i).filter(i => i % 3 === 0).length;
    assert.equal(result.skipped, expectedBad);
    assert.equal(result.signals.length, 20 - expectedBad);
  });

  test('a page exactly matching the batch size still terminates correctly against an empty next page', async () => {
    const now = clock.now();
    for (let i = 0; i < 6; i++) insertSignal({id: `sig-${i}`, detectedAt: now + i});
    const result = await readAllSignalsWithOutcomes(d1, {signalBatchSize: 6});
    assert.equal(result.signals.length, 6);
    assert.equal(result.truncated, false);
  });

  test('hitting the batch cap reports truncated and stops reading, rather than looping unbounded', async () => {
    const now = clock.now();
    for (let i = 0; i < 20; i++) insertSignal({id: `sig-${String(i).padStart(2, '0')}`, detectedAt: now + i});
    const result = await readAllSignalsWithOutcomes(d1, {signalBatchSize: 5, maxSignalBatches: 2});
    assert.equal(result.signals.length, 10, 'only the first two batches (2 * 5) were read');
    assert.equal(result.truncated, true);
  });

  test('the read is read-only: no INSERT/UPDATE/DELETE statement is ever issued', async () => {
    const now = clock.now();
    for (let i = 0; i < 8; i++) insertSignal({id: `sig-${i}`, detectedAt: now + i});
    d1.queries.length = 0;
    await readAllSignalsWithOutcomes(d1, {signalBatchSize: 3});
    assert.ok(d1.queries.every(sql => /^\s*SELECT/i.test(sql)), `expected only SELECTs, saw: ${d1.queries.join(' | ')}`);
  });
});
