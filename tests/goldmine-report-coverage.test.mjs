// The backtest report states the exact window it covers (lib/goldmine/backtest.ts reportCoverage, shown by
// lib/goldmine/backtest-view.ts coverageWindowLabel). At a 15-minute detection cadence the 2,000-row read
// bound reaches back only days, so a report must never read as "30 days" or "all history" when it is not.
import assert from 'node:assert/strict';
import {beforeEach, describe, test} from 'node:test';
import {body, createD1, jsonRequest, runtime, signIn, startClock} from './helpers/harness.mjs';
import {pair} from './helpers/goldmine-fixtures.mjs';

const {GET} = await import('../app/api/goldmine/backtest/route.ts');
const {reportCoverage, RESEARCH_TARGET_DAYS} = await import('../lib/goldmine/backtest.ts');
const {coverageWindowLabel} = await import('../lib/goldmine/backtest-view.ts');
const {MAX_RETAINED_SIGNALS} = await import('../lib/goldmine/signals.ts');
const {MODEL_VERSION, scoreCandidate} = await import('../lib/goldmine/score.ts');
const {snapshotFromPair} = await import('../lib/goldmine/snapshot.ts');

const MINUTE = 60000, DAY = 24 * 60 * MINUTE;
const NOW = Date.UTC(2026, 9, 1);
const rows = detectedAts => detectedAts.map(detectedAt => ({detectedAt}));

describe('reportCoverage', () => {
  test('a young history read in full is fully analyzed, and its real span is reported', () => {
    const coverage = reportCoverage(rows([NOW - 2 * DAY, NOW - DAY, NOW]), 3, false, NOW);
    assert.deepEqual(coverage, {signalsAnalyzed: 3, storedSignals: 3, truncated: false, oldestAnalyzedAt: NOW - 2 * DAY, newestAnalyzedAt: NOW, targetWindowDays: RESEARCH_TARGET_DAYS, targetWindowFullyAnalyzed: true});
    const label = coverageWindowLabel(coverage);
    assert.match(label, /^Covers 3 of 3 stored signals, detected 2026-09-29 00:00 UTC to 2026-10-01 00:00 UTC \(2\.0 days\)\./);
    assert.match(label, /shorter than the 30-day research target/);
  });

  test('a truncated read reaching back only 3 days does not cover the 30-day target, and says so', () => {
    const coverage = reportCoverage(rows([NOW - 3 * DAY, NOW]), 5000, true, NOW);
    assert.equal(coverage.targetWindowFullyAnalyzed, false);
    const label = coverageWindowLabel(coverage);
    assert.match(label, /^Covers only the newest 2 of 5000 stored signals/);
    assert.match(label, /less than the 30-day research target: older stored signals were not read/);
    assert.doesNotMatch(label, /all history|all stored/i);
  });

  test('a truncated read whose oldest row is at least 30 days old covers the target window, not all history', () => {
    const coverage = reportCoverage(rows([NOW - 31 * DAY, NOW]), 9000, true, NOW);
    assert.equal(coverage.targetWindowFullyAnalyzed, true);
    assert.match(coverageWindowLabel(coverage), /Every signal from the 30-day research target window is included; older stored signals are not\./);
  });

  test('no signals: no window to claim', () => {
    const coverage = reportCoverage([], 0, false, NOW);
    assert.equal(coverage.oldestAnalyzedAt, null);
    assert.equal(coverageWindowLabel(coverage), '');
    assert.equal(coverageWindowLabel(undefined), '');
  });
});

describe('GET /api/goldmine/backtest coverage at a 15-minute cadence', () => {
  let d1;
  beforeEach(() => {
    startClock();
    d1 = createD1();
    runtime.env.DB = d1;
    signIn('user-a');
  });

  test('2,001 signals 15 minutes apart: only the newest 2,000 (~20.8 days) are analyzed, disclosed as short of 30 days', async () => {
    const snapshot = snapshotFromPair(pair(), NOW);
    const assessment = {...scoreCandidate(snapshot), modelVersion: MODEL_VERSION};
    const snapshotJson = JSON.stringify(snapshot), assessmentJson = JSON.stringify(assessment);
    const insert = d1.sqlite.prepare('INSERT INTO goldmine_signals (id, address, pair, symbol, model_version, state, score, opportunity, detected_at, detected_price, snapshot, assessment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const newest = Date.now();
    const total = MAX_RETAINED_SIGNALS + 1;
    for (let i = 0; i < total; i++) {
      insert.run(`sig-${String(i).padStart(5, '0')}`, snapshot.address, snapshot.pair, snapshot.symbol, MODEL_VERSION, assessment.state, assessment.score, 0, newest - (total - 1 - i) * 15 * MINUTE, 1, snapshotJson, assessmentJson);
    }
    const data = await body(await GET(jsonRequest('/api/goldmine/backtest')));
    assert.deepEqual(data.coverage, {
      signalsAnalyzed: MAX_RETAINED_SIGNALS, storedSignals: total, truncated: true,
      oldestAnalyzedAt: newest - (MAX_RETAINED_SIGNALS - 1) * 15 * MINUTE, newestAnalyzedAt: newest,
      targetWindowDays: 30, targetWindowFullyAnalyzed: false,
    });
    const label = coverageWindowLabel(data.coverage);
    assert.match(label, /Covers only the newest 2000 of 2001 stored signals/);
    assert.match(label, /\(20\.8 days\)/);
    assert.match(label, /less than the 30-day research target/);
  });
});
