// Stage 09A: lib/goldmine/evidence-view.ts, the pure labels, freshness tiers and near-miss selection the
// review-evidence panel renders. Deterministic: every function takes `now` explicitly.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import './helpers/harness.mjs'; // registers the extensionless-import loader the lib modules rely on

const view = await import('../lib/goldmine/evidence-view.ts');
const {reviewEvidence} = await import('../lib/goldmine/review-evidence.ts');
const {MAX_FACT_AGE_MS} = await import('../lib/goldmine/contract-safety.ts');
const {CLOCK_SKEW_MS} = await import('../lib/goldmine/snapshot.ts');
const {MODEL_VERSION} = await import('../lib/goldmine/score.ts');
const {freshnessTier, worseTier, ageLabel, STATUS_LABEL, TIER_LABEL, TIER_SENTENCE, summaryLine, nearMisses, factorValue, evidenceTier, EVIDENCE_RECENT_MS, MANUAL_CHECKS} = view;

const NOW = Date.UTC(2026, 8, 30, 12);
const MINUTE = 60000;

describe('freshness tiers', () => {
  test('the recent boundary is the safety fact-age limit, not a new number', () => {
    assert.equal(EVIDENCE_RECENT_MS, MAX_FACT_AGE_MS);
  });

  test('past times: recent up to 15 minutes inclusive, stale one millisecond later', () => {
    assert.equal(freshnessTier(NOW, NOW), 'recent');
    assert.equal(freshnessTier(NOW - 15 * MINUTE, NOW), 'recent');
    assert.equal(freshnessTier(NOW - 15 * MINUTE - 1, NOW), 'stale');
    assert.equal(freshnessTier(NOW - 30 * 24 * 60 * MINUTE, NOW), 'stale');
  });

  test('a future time is never recent: uncertain within the clock tolerance, invalid beyond it', () => {
    assert.equal(CLOCK_SKEW_MS, 5 * MINUTE);
    assert.equal(freshnessTier(NOW + 1, NOW), 'uncertain');
    assert.equal(freshnessTier(NOW + CLOCK_SKEW_MS, NOW), 'uncertain');
    assert.equal(freshnessTier(NOW + CLOCK_SKEW_MS + 1, NOW), 'invalid');
    assert.equal(freshnessTier(NOW + 60 * MINUTE, NOW), 'invalid');
  });

  test('missing or garbage times are unknown', () => {
    for (const value of [null, undefined, NaN, Infinity, '2026-09-30', {}]) assert.equal(freshnessTier(value, NOW), 'unknown', String(value));
    assert.equal(freshnessTier(NOW, NaN), 'unknown');
  });

  test('worseTier orders invalid > unknown > uncertain > stale > recent, in either argument order', () => {
    const order = ['invalid', 'unknown', 'uncertain', 'stale', 'recent'];
    for (const [i, a] of order.entries()) for (const [j, b] of order.entries()) {
      assert.equal(worseTier(a, b), order[Math.min(i, j)], `${a} vs ${b}`);
    }
  });

  test('age labels never give an age to a future or unknown time', () => {
    assert.equal(ageLabel(NOW - 30 * 1000, NOW), 'under a minute ago');
    assert.equal(ageLabel(NOW - 4 * MINUTE, NOW), '4 min ago');
    assert.equal(ageLabel(NOW - 125 * MINUTE, NOW), '2 h 5 min ago');
    assert.equal(ageLabel(NOW - 3 * 24 * 60 * MINUTE, NOW), '3 days ago');
    assert.equal(ageLabel(NOW + MINUTE, NOW), 'time uncertain');
    assert.equal(ageLabel(NOW + 60 * MINUTE, NOW), 'time invalid');
    assert.equal(ageLabel(null, NOW), 'time unknown');
  });
});

describe('the market and RugCheck times are classified separately', () => {
  const evidence = (marketObservedAt, reportAt, status = 'verified') => ({...reviewEvidence({observedAt: marketObservedAt, contractSafety: {status, source: 'rugcheck', checkedAt: reportAt, facts: {}}}, {}), marketObservedAt});

  test('a recent snapshot with a stale report: the summary uses the worse (stale)', () => {
    const e = evidence(NOW - MINUTE, NOW - 40 * MINUTE);
    assert.equal(freshnessTier(e.marketObservedAt, NOW), 'recent');
    assert.equal(view.safetyReportTier(e, NOW), 'stale');
    assert.equal(evidenceTier(e, NOW), 'stale');
  });

  test('a report time in the future makes the summary invalid even when the snapshot is recent', () => {
    assert.equal(evidenceTier(evidence(NOW - MINUTE, NOW + 60 * MINUTE), NOW), 'invalid');
  });

  test('no attached report does not age the market snapshot', () => {
    const e = reviewEvidence({observedAt: NOW - MINUTE, contractSafety: {status: 'unavailable', source: null}}, {});
    assert.equal(view.safetyReportTier(e, NOW), null);
    assert.equal(evidenceTier(e, NOW), 'recent');
  });
});

describe('labels never read as a pass', () => {
  test('no status, tier or sentence says safe, passed or verified', () => {
    for (const label of [...Object.values(STATUS_LABEL), ...Object.values(TIER_LABEL), ...Object.values(TIER_SENTENCE)]) {
      // Word-bounded so "unverified" (the honest word for unknown) is allowed.
      assert.doesNotMatch(label, /\b(safe|pass|passed|verified)\b/i, label);
    }
  });

  test('values: booleans say what they mean, missing is a dash', () => {
    assert.equal(factorValue({id: 'mint_authority', value: true}), 'Renounced');
    assert.equal(factorValue({id: 'mint_authority', value: false}), 'Active');
    assert.equal(factorValue({id: 'rugged_flag', value: false}), 'No');
    assert.equal(factorValue({id: 'creator_holding', value: 3.25}), '3.3%');
    assert.equal(factorValue({id: 'price_change_h1', value: 12}), '+12%');
    assert.equal(factorValue({id: 'liquidity_usd', value: 150000}), '$150,000');
    assert.equal(factorValue({id: 'pool_age_minutes', value: 90}), '90 min');
    assert.equal(factorValue({id: 'market_cap_usd', value: null}), '—');
  });
});

describe('summary line', () => {
  test('counts come straight from the evidence, and the manual checks always count as not measured', () => {
    const e = {...reviewEvidence({observedAt: NOW - 3 * 60 * MINUTE, contractSafety: {status: 'unavailable', source: null}}, {state: 'BUILDING'}), hardFailures: ['A'], flags: ['B', 'C']};
    const notMeasured = e.factors.filter(item => item.status === 'not_measured').length + MANUAL_CHECKS.length;
    assert.equal(summaryLine(e, NOW), `1 hard failure recorded · 1 item not verified · 2 research flags · ${notMeasured} not measured · snapshot 3 h 0 min ago (past snapshot)`);
  });

  test('missing or unreadable evidence says so instead of looking clean', () => {
    assert.match(summaryLine(undefined, NOW), /not included/);
    assert.match(summaryLine(null, NOW), /not included/);
    assert.match(summaryLine(reviewEvidence(null, null), NOW), /unreadable/);
  });

  test('a future snapshot time is labelled, not aged', () => {
    const e = reviewEvidence({observedAt: NOW + 2 * MINUTE, contractSafety: {status: 'unavailable', source: null}}, {});
    assert.match(summaryLine(e, NOW), / · time uncertain$/);
  });
});

describe('near misses', () => {
  const signal = (overrides = {}) => ({id: overrides.id ?? 's', address: 'MintA', pair: 'PoolA', modelVersion: MODEL_VERSION, state: 'BUILDING', opportunity: false, detectedAt: '2026-09-30T10:00:00.000Z', ...overrides});

  test('current model, not rejected, not an opportunity; newest first; one per mint and pool', () => {
    const rows = [
      signal({id: 'old', detectedAt: '2026-09-30T08:00:00.000Z'}),
      signal({id: 'new', detectedAt: '2026-09-30T11:00:00.000Z'}),
      signal({id: 'other-pool', pair: 'PoolB', detectedAt: '2026-09-30T09:00:00.000Z'}),
      signal({id: 'rejected', address: 'MintR', state: 'REJECTED'}),
      signal({id: 'opportunity', address: 'MintO', opportunity: true}),
      signal({id: 'old-model', address: 'MintM', modelVersion: 'momentum-v1.0.0'}),
      signal({id: 'no-model', address: 'MintN', modelVersion: undefined}),
    ];
    assert.deepEqual(nearMisses(rows).map(row => row.id), ['new', 'other-pool']);
  });

  test('empty input gives an empty list; an unparseable time sorts last, never throws', () => {
    assert.deepEqual(nearMisses([]), []);
    assert.deepEqual(nearMisses([signal({id: 'bad', address: 'M1', detectedAt: 'garbage'}), signal({id: 'good', address: 'M2'})]).map(row => row.id), ['good', 'bad']);
  });
});
