// lib/goldmine/signals.ts readAllSignalsWithOutcomes: structural validation of stored snapshot/assessment/
// outcome JSON (isValidStoredSnapshot/isValidStoredAssessment/isValidStoredOutcomeRow) and bounded,
// keyset-paginated batching over goldmine_signals/goldmine_outcomes. No provider call, no writes - a real
// (in-memory sqlite) D1 database.
import assert from 'node:assert/strict';
import {beforeEach, describe, test} from 'node:test';
import {createD1, runtime, startClock} from './helpers/harness.mjs';
import {pair} from './helpers/goldmine-fixtures.mjs';

const {isValidStoredSnapshot, isValidStoredAssessment, isValidStoredOutcomeRow, readAllSignalsWithOutcomes} = await import('../lib/goldmine/signals.ts');
const {MODEL_VERSION, scoreCandidate} = await import('../lib/goldmine/score.ts');
const {snapshotFromPair} = await import('../lib/goldmine/snapshot.ts');

const MINUTE = 60000;
const validSnapshot = () => snapshotFromPair(pair(), Date.UTC(2026, 8, 18, 12));
const validAssessment = () => scoreCandidate(validSnapshot());
const unsafeContractSafety = () => ({status: 'unsafe', source: 'fixture', checkedAt: 1, facts: validFacts(), failedChecks: ['Mint authority not renounced.']});
const validFacts = () => ({
  mintAuthorityRenounced: true, freezeAuthorityRenounced: true, lpLockedPct: 100, totalMarketLiquidityUsd: 150000,
  topHolderPct: 5, topHoldersPct: 20, creatorHoldingsPct: 1, insiderNetworksDetected: 0, rugged: false,
  providerScoreNormalized: 90, providerRisks: [],
});

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

  // --- Discriminated-union contractSafety validation (Opus finding #1, High) -----------------------------
  describe('contractSafety as a real discriminated union', () => {
    test('accepts a well-formed unsafe status', () => {
      assert.equal(isValidStoredSnapshot({...validSnapshot(), contractSafety: unsafeContractSafety()}), true);
    });
    test('rejects {status: "unsafe"} with no failedChecks at all - the exact reproduction from the review', () => {
      assert.equal(isValidStoredSnapshot({...validSnapshot(), contractSafety: {status: 'unsafe'}}), false);
    });
    test('rejects unsafe with failedChecks as a string instead of string[]', () => {
      assert.equal(isValidStoredSnapshot({...validSnapshot(), contractSafety: {...unsafeContractSafety(), failedChecks: 'mint not renounced'}}), false);
    });
    test('rejects unsafe with failedChecks as an object instead of an array', () => {
      assert.equal(isValidStoredSnapshot({...validSnapshot(), contractSafety: {...unsafeContractSafety(), failedChecks: {0: 'x'}}}), false);
    });
    test('rejects unsafe with a failedChecks array containing a non-string entry', () => {
      assert.equal(isValidStoredSnapshot({...validSnapshot(), contractSafety: {...unsafeContractSafety(), failedChecks: ['ok', 42]}}), false);
    });
    test('rejects unsafe with an empty failedChecks array', () => {
      assert.equal(isValidStoredSnapshot({...validSnapshot(), contractSafety: {...unsafeContractSafety(), failedChecks: []}}), false);
    });
    test('rejects an unknown contract-safety status', () => {
      assert.equal(isValidStoredSnapshot({...validSnapshot(), contractSafety: {status: 'bogus', source: 'x'}}), false);
    });
    test('accepts a well-formed verified status', () => {
      assert.equal(isValidStoredSnapshot({...validSnapshot(), contractSafety: {status: 'verified', source: 'fixture', checkedAt: 1, facts: validFacts()}}), true);
    });
    test('rejects verified missing its facts object', () => {
      assert.equal(isValidStoredSnapshot({...validSnapshot(), contractSafety: {status: 'verified', source: 'fixture', checkedAt: 1}}), false);
    });
    test('accepts unavailable only with source: null', () => {
      assert.equal(isValidStoredSnapshot({...validSnapshot(), contractSafety: {status: 'unavailable', source: null}}), true);
      assert.equal(isValidStoredSnapshot({...validSnapshot(), contractSafety: {status: 'unavailable', source: 'x'}}), false);
    });
  });

  // --- Non-negative / range validation (Opus finding #1 and #6) -------------------------------------------
  describe('impossible numeric values are rejected', () => {
    test('rejects negative liquidityUsd', () => assert.equal(isValidStoredSnapshot({...validSnapshot(), liquidityUsd: -1}), false));
    test('rejects negative marketCapUsd', () => assert.equal(isValidStoredSnapshot({...validSnapshot(), marketCapUsd: -100}), false));
    test('rejects negative ageMinutes', () => assert.equal(isValidStoredSnapshot({...validSnapshot(), ageMinutes: -5}), false));
    test('rejects a negative transaction count', () => {
      const snapshot = validSnapshot();
      assert.equal(isValidStoredSnapshot({...snapshot, txns: {...snapshot.txns, h1: {buys: -1, sells: 5}}}), false);
    });
    test('rejects negative volumeUsd', () => {
      const snapshot = validSnapshot();
      assert.equal(isValidStoredSnapshot({...snapshot, volumeUsd: {...snapshot.volumeUsd, h1: -500}}), false);
    });
    test('rejects NaN priceUsd', () => assert.equal(isValidStoredSnapshot({...validSnapshot(), priceUsd: NaN}), false));
    test('rejects Infinity liquidityUsd', () => assert.equal(isValidStoredSnapshot({...validSnapshot(), liquidityUsd: Infinity}), false));
    test('rejects a zero or negative priceUsd (a real snapshot never stores one - null is used instead)', () => {
      assert.equal(isValidStoredSnapshot({...validSnapshot(), priceUsd: 0}), false);
      assert.equal(isValidStoredSnapshot({...validSnapshot(), priceUsd: -1}), false);
    });
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

  // --- Enum/range validation (Opus finding #6, Low) --------------------------------------------------
  test('rejects an unknown assessment state', () => {
    assert.equal(isValidStoredAssessment({...validAssessment(), state: 'FOO'}), false);
  });
  test('rejects a negative score', () => {
    assert.equal(isValidStoredAssessment({...validAssessment(), score: -1}), false);
  });
  test('rejects a score above the maximum possible (100)', () => {
    assert.equal(isValidStoredAssessment({...validAssessment(), score: 101}), false);
  });
  test('rejects a non-finite score', () => {
    assert.equal(isValidStoredAssessment({...validAssessment(), score: NaN}), false);
    assert.equal(isValidStoredAssessment({...validAssessment(), score: Infinity}), false);
  });
});

describe('isValidStoredOutcomeRow', () => {
  const base = {horizon: '15m', status: 'pending', observed_at: null, price: null, liquidity: null};
  test('accepts a well-formed pending row', () => assert.equal(isValidStoredOutcomeRow(base), true));
  test('accepts a well-formed observed row', () => {
    assert.equal(isValidStoredOutcomeRow({...base, status: 'observed', observed_at: 1, price: 1.2, liquidity: 1000}), true);
  });
  test('accepts a well-formed observed row with null liquidity', () => {
    assert.equal(isValidStoredOutcomeRow({...base, status: 'observed', observed_at: 1, price: 1.2, liquidity: null}), true);
  });
  test('accepts a well-formed unavailable row', () => {
    assert.equal(isValidStoredOutcomeRow({...base, status: 'unavailable', observed_at: 1}), true);
  });
  test('accepts a well-formed missed row', () => assert.equal(isValidStoredOutcomeRow({...base, status: 'missed'}), true));
  test('rejects an unknown status string ("CORRUPT")', () => assert.equal(isValidStoredOutcomeRow({...base, status: 'CORRUPT'}), false));
  test('rejects a wrong-case known status ("Observed")', () => assert.equal(isValidStoredOutcomeRow({...base, status: 'Observed', observed_at: 1, price: 1}), false));
  test('rejects an unknown horizon', () => assert.equal(isValidStoredOutcomeRow({...base, horizon: '3d'}), false));
  test('rejects observed with a missing (null) price', () => assert.equal(isValidStoredOutcomeRow({...base, status: 'observed', observed_at: 1, price: null}), false));
  test('rejects observed with a NaN price', () => assert.equal(isValidStoredOutcomeRow({...base, status: 'observed', observed_at: 1, price: NaN}), false));
  test('rejects observed with an infinite price', () => assert.equal(isValidStoredOutcomeRow({...base, status: 'observed', observed_at: 1, price: Infinity}), false));
  test('rejects observed with a non-positive price', () => assert.equal(isValidStoredOutcomeRow({...base, status: 'observed', observed_at: 1, price: 0}), false));
  test('rejects observed with a negative liquidity', () => assert.equal(isValidStoredOutcomeRow({...base, status: 'observed', observed_at: 1, price: 1, liquidity: -1}), false));
  test('rejects pending with a non-null price', () => assert.equal(isValidStoredOutcomeRow({...base, price: 1}), false));
});

let d1, clock;
function insertSignal({id, detectedAt, modelVersion = MODEL_VERSION, state, detectedPrice, snapshotJson, assessmentJson}) {
  const snapshot = validSnapshot();
  const assessment = {...scoreCandidate(snapshot), modelVersion};
  d1.sqlite.prepare('INSERT INTO goldmine_signals (id, address, pair, symbol, model_version, state, score, opportunity, detected_at, detected_price, snapshot, assessment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, id, id, 'SYM', modelVersion, state ?? assessment.state, assessment.score, assessment.opportunity ? 1 : 0, detectedAt, detectedPrice ?? 1,
      snapshotJson !== undefined ? snapshotJson : JSON.stringify(snapshot), assessmentJson !== undefined ? assessmentJson : JSON.stringify(assessment));
}
function insertOutcome(signalId, horizon, {status = 'pending', dueAt, price = null} = {}) {
  d1.sqlite.prepare('INSERT INTO goldmine_outcomes (signal_id, horizon, due_at, deadline_at, status, observed_at, price, liquidity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(signalId, horizon, dueAt, dueAt + MINUTE, status, status === 'observed' || status === 'unavailable' ? dueAt : null, price, status === 'observed' ? 1000 : null);
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
    assert.equal(result.skippedMalformedSignals, 7);
    assert.equal(result.signals.length, 1);
    assert.equal(result.signals[0].id, 'ok');
    assert.equal(result.truncated, false);
  });

  test('a snapshot with {status: "unsafe"} and no failedChecks is skipped, not crashed on (the reproduced High finding)', async () => {
    const now = clock.now();
    const snapshot = {...validSnapshot(), contractSafety: {status: 'unsafe'}};
    insertSignal({id: 'unsafe-no-checks', detectedAt: now, snapshotJson: JSON.stringify(snapshot)});
    insertSignal({id: 'ok', detectedAt: now + 1});
    const result = await readAllSignalsWithOutcomes(d1);
    assert.equal(result.skippedMalformedSignals, 1);
    assert.equal(result.signals.length, 1);
    assert.equal(result.signals[0].id, 'ok');
  });

  test('a stored column model_version that disagrees with the assessment content is skipped, not replayed under either interpretation', async () => {
    const now = clock.now();
    const snapshot = validSnapshot();
    const assessment = {...scoreCandidate(snapshot), modelVersion: 'momentum-v9.9.9'}; // assessment says v9.9.9
    insertSignal({id: 'mismatch', detectedAt: now, modelVersion: MODEL_VERSION, assessmentJson: JSON.stringify(assessment)}); // column says current
    insertSignal({id: 'ok', detectedAt: now + 1});
    const result = await readAllSignalsWithOutcomes(d1);
    assert.equal(result.skippedMalformedSignals, 1);
    assert.equal(result.signals.length, 1);
    assert.equal(result.signals[0].id, 'ok');
  });

  test('a stored column state that disagrees with the assessment content is skipped', async () => {
    const now = clock.now();
    const snapshot = validSnapshot();
    const assessment = scoreCandidate(snapshot); // e.g. BREAKOUT
    insertSignal({id: 'state-mismatch', detectedAt: now, state: 'REJECTED', assessmentJson: JSON.stringify(assessment)});
    insertSignal({id: 'ok', detectedAt: now + 1});
    const result = await readAllSignalsWithOutcomes(d1);
    assert.equal(result.skippedMalformedSignals, 1);
    assert.equal(result.signals.length, 1);
  });

  test('a non-positive or non-finite detected_price is skipped', async () => {
    const now = clock.now();
    insertSignal({id: 'zero-price', detectedAt: now, detectedPrice: 0});
    insertSignal({id: 'negative-price', detectedAt: now + 1, detectedPrice: -1});
    insertSignal({id: 'ok', detectedAt: now + 2});
    const result = await readAllSignalsWithOutcomes(d1);
    assert.equal(result.skippedMalformedSignals, 2);
    assert.equal(result.signals.length, 1);
  });

  test('valid and invalid rows mixed keep every valid row and count skipped accurately', async () => {
    const now = clock.now();
    for (let i = 0; i < 5; i++) insertSignal({id: `ok-${i}`, detectedAt: now + i});
    for (let i = 0; i < 3; i++) insertSignal({id: `bad-${i}`, detectedAt: now + 10 + i, snapshotJson: '{}'});
    const result = await readAllSignalsWithOutcomes(d1);
    assert.equal(result.signals.length, 5);
    assert.equal(result.skippedMalformedSignals, 3);
  });
});

describe('readAllSignalsWithOutcomes: malformed outcomes (never silently counted as pending)', () => {
  test('an unknown outcome status is excluded and counted separately, never folded into pending coverage', async () => {
    const now = clock.now();
    insertSignal({id: 'sig-1', detectedAt: now});
    d1.sqlite.prepare('INSERT INTO goldmine_outcomes (signal_id, horizon, due_at, deadline_at, status, observed_at, price, liquidity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('sig-1', '15m', now, now + MINUTE, 'CORRUPT', null, null, null);
    const result = await readAllSignalsWithOutcomes(d1);
    assert.equal(result.outcomes.length, 0);
    assert.equal(result.skippedMalformedOutcomes, 1);
  });

  test('a wrong-case known status ("Observed") is excluded, not treated as observed or pending', async () => {
    const now = clock.now();
    insertSignal({id: 'sig-1', detectedAt: now});
    d1.sqlite.prepare('INSERT INTO goldmine_outcomes (signal_id, horizon, due_at, deadline_at, status, observed_at, price, liquidity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('sig-1', '15m', now, now + MINUTE, 'Observed', now, 1.1, 100);
    const result = await readAllSignalsWithOutcomes(d1);
    assert.equal(result.outcomes.length, 0);
    assert.equal(result.skippedMalformedOutcomes, 1);
  });

  test('an observed outcome with a NaN/missing return-producing price is excluded and counted', async () => {
    const now = clock.now();
    insertSignal({id: 'sig-1', detectedAt: now});
    d1.sqlite.prepare('INSERT INTO goldmine_outcomes (signal_id, horizon, due_at, deadline_at, status, observed_at, price, liquidity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('sig-1', '15m', now, now + MINUTE, 'observed', now, null, null);
    const result = await readAllSignalsWithOutcomes(d1);
    assert.equal(result.outcomes.length, 0);
    assert.equal(result.skippedMalformedOutcomes, 1);
  });

  test('valid and malformed outcomes mixed: valid ones are kept, malformed ones counted, accurately', async () => {
    const now = clock.now();
    insertSignal({id: 'sig-1', detectedAt: now});
    insertOutcome('sig-1', '15m', {status: 'observed', dueAt: now, price: 1.1});
    insertOutcome('sig-1', '1h', {status: 'pending', dueAt: now});
    d1.sqlite.prepare('INSERT INTO goldmine_outcomes (signal_id, horizon, due_at, deadline_at, status, observed_at, price, liquidity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('sig-1', '6h', now, now + MINUTE, 'CORRUPT', null, null, null);
    const result = await readAllSignalsWithOutcomes(d1);
    assert.equal(result.outcomes.length, 2);
    assert.equal(result.skippedMalformedOutcomes, 1);
  });

  test('a malformed outcome never fails the whole read', async () => {
    const now = clock.now();
    insertSignal({id: 'sig-1', detectedAt: now});
    d1.sqlite.prepare('INSERT INTO goldmine_outcomes (signal_id, horizon, due_at, deadline_at, status, observed_at, price, liquidity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('sig-1', '15m', now, now + MINUTE, 'CORRUPT', null, null, null);
    const result = await readAllSignalsWithOutcomes(d1);
    assert.equal(result.signals.length, 1);
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

  test('results are returned in ascending chronological order, whatever the internal (descending) read order', async () => {
    const now = clock.now();
    for (let i = 0; i < 9; i++) insertSignal({id: `sig-${i}`, detectedAt: now + i});
    const result = await readAllSignalsWithOutcomes(d1, {signalBatchSize: 4});
    assert.deepEqual(result.signals.map(s => s.detectedAt), result.signals.map(s => s.detectedAt).slice().sort((a, b) => a - b));
    assert.deepEqual(result.signals.map(s => s.id), Array.from({length: 9}, (_, i) => `sig-${i}`));
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
    assert.equal(result.skippedMalformedSignals, expectedBad);
    assert.equal(result.signals.length, 20 - expectedBad);
  });

  test('a page exactly matching the batch size still terminates correctly against an empty next page', async () => {
    const now = clock.now();
    for (let i = 0; i < 6; i++) insertSignal({id: `sig-${i}`, detectedAt: now + i});
    const result = await readAllSignalsWithOutcomes(d1, {signalBatchSize: 6});
    assert.equal(result.signals.length, 6);
    assert.equal(result.truncated, false);
  });

  // --- Exact-cap truncation semantics (Opus finding #3, Medium) ---------------------------------------
  test('history of exactly maxSignalBatches * signalBatchSize rows is NOT reported truncated (exact-cap lookahead)', async () => {
    const now = clock.now();
    for (let i = 0; i < 10; i++) insertSignal({id: `sig-${String(i).padStart(2, '0')}`, detectedAt: now + i}); // exactly 5 * 2
    const result = await readAllSignalsWithOutcomes(d1, {signalBatchSize: 5, maxSignalBatches: 2});
    assert.equal(result.signals.length, 10);
    assert.equal(result.truncated, false, 'exactly the cap, no additional row: must not report truncated');
  });

  test('history of the cap plus one extra row IS reported truncated', async () => {
    const now = clock.now();
    for (let i = 0; i < 11; i++) insertSignal({id: `sig-${String(i).padStart(2, '0')}`, detectedAt: now + i}); // cap (10) + 1
    const result = await readAllSignalsWithOutcomes(d1, {signalBatchSize: 5, maxSignalBatches: 2});
    assert.equal(result.signals.length, 10);
    assert.equal(result.truncated, true, 'cap plus at least one more row: must report truncated');
  });

  test('hitting the batch cap reports truncated and stops reading, rather than looping unbounded', async () => {
    const now = clock.now();
    for (let i = 0; i < 20; i++) insertSignal({id: `sig-${String(i).padStart(2, '0')}`, detectedAt: now + i});
    const result = await readAllSignalsWithOutcomes(d1, {signalBatchSize: 5, maxSignalBatches: 2});
    assert.equal(result.signals.length, 10, 'only the first two batches (2 * 5) were read');
    assert.equal(result.truncated, true);
  });

  test('a truncated read retains the newest signals, not the oldest', async () => {
    const now = clock.now();
    for (let i = 0; i < 20; i++) insertSignal({id: `sig-${String(i).padStart(2, '0')}`, detectedAt: now + i}); // sig-19 is newest
    const result = await readAllSignalsWithOutcomes(d1, {signalBatchSize: 5, maxSignalBatches: 2});
    assert.equal(result.truncated, true);
    const ids = result.signals.map(s => s.id).sort();
    // The 10 kept signals must be the 10 most recently detected: sig-10..sig-19.
    assert.deepEqual(ids, Array.from({length: 10}, (_, i) => `sig-${String(i + 10).padStart(2, '0')}`));
  });

  test('the read is read-only: no INSERT/UPDATE/DELETE statement is ever issued', async () => {
    const now = clock.now();
    for (let i = 0; i < 8; i++) insertSignal({id: `sig-${i}`, detectedAt: now + i});
    d1.queries.length = 0;
    await readAllSignalsWithOutcomes(d1, {signalBatchSize: 3});
    assert.ok(d1.queries.every(sql => /^\s*SELECT/i.test(sql)), `expected only SELECTs, saw: ${d1.queries.join(' | ')}`);
  });
});
