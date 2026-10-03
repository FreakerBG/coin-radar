// Stage 09A: lib/goldmine/review-evidence.ts, the allow-listed review view of a recorded signal. Inputs are
// built with the real pipeline (snapshotFromPair, deriveContractSafety, scoreCandidate) so these tests
// describe what stored rows actually look like. Nothing here touches a network or a database.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {NOW, cases, pair} from './helpers/goldmine-fixtures.mjs';

const {reviewEvidence, FACTOR_IDS, REVIEW_EVIDENCE_VERSION} = await import('../lib/goldmine/review-evidence.ts');
const {deriveContractSafety} = await import('../lib/goldmine/contract-safety.ts');
const {snapshotFromPair} = await import('../lib/goldmine/snapshot.ts');
const {scoreCandidate} = await import('../lib/goldmine/score.ts');

const REPORT_AT = NOW - 4 * 60000;
function report(overrides = {}) {
  return {
    token: {mintAuthority: null, freezeAuthority: null, supply: 1_000_000_000, decimals: 6},
    rugged: false, totalMarketLiquidity: 250000,
    topHolders: [{pct: 8}, {pct: 5}, {pct: 3}],
    creatorBalance: 10_000_000, graphInsidersDetected: 0, score_normalised: 5,
    risks: [{name: 'Mutable metadata', level: 'warn', description: 'PROVIDER-AUTHORED TEXT that must never reach the client'}],
    markets: [{lp: {quoteUSD: 50000, baseUSD: 50000, lpLockedPct: 95}}],
    ...overrides,
  };
}
// A stored row exactly as recordSignals writes it: the snapshot with its contract safety, and the
// assessment scored from that same snapshot.
function stored(pairOverrides = {}, safetyReport = report()) {
  const snapshot = snapshotFromPair(pair(pairOverrides), NOW);
  if (safetyReport) snapshot.contractSafety = deriveContractSafety(safetyReport, REPORT_AT, NOW);
  return {snapshot, assessment: scoreCandidate(snapshot)};
}
const evidenceOf = ({snapshot, assessment}) => reviewEvidence(snapshot, assessment);
const factor = (evidence, id) => evidence.factors.find(item => item.id === id);
const contractIds = ['mint_authority', 'freeze_authority', 'lp_locked', 'largest_holder', 'top_holders', 'creator_holding', 'insider_networks', 'rugged_flag'];

describe('verified contract safety', () => {
  test('every contract fact is shown with its value and the report time, and reads "within check at scan"', () => {
    const row = stored();
    assert.equal(row.snapshot.contractSafety.status, 'verified');
    const evidence = evidenceOf(row);
    assert.equal(evidence.version, REVIEW_EVIDENCE_VERSION);
    assert.deepEqual(evidence.safety, {status: 'verified', reportAt: REPORT_AT, unavailableReason: null});
    assert.equal(evidence.marketObservedAt, NOW);
    for (const id of contractIds) {
      assert.equal(factor(evidence, id).status, 'within_check', id);
      assert.equal(factor(evidence, id).asOf, REPORT_AT, id);
      assert.equal(factor(evidence, id).source, 'rugcheck', id);
    }
    assert.equal(factor(evidence, 'creator_holding').value, 1);
    assert.equal(factor(evidence, 'largest_holder').value, 8);
    assert.equal(factor(evidence, 'top_holders').value, 16);
    assert.equal(factor(evidence, 'lp_locked').value, 95);
    assert.equal(factor(evidence, 'mint_authority').value, true);
    assert.deepEqual(evidence.hardFailures, []);
  });

  test('market values carry the snapshot time, never the report time', () => {
    const evidence = evidenceOf(stored());
    for (const id of ['liquidity_usd', 'market_cap_usd', 'volume_h24_usd', 'pool_age_minutes', 'buys_h1', 'sells_h1']) {
      assert.equal(factor(evidence, id).source, 'dexscreener', id);
      assert.equal(factor(evidence, id).asOf, NOW, id);
      assert.equal(factor(evidence, id).status, 'recorded', id);
    }
    assert.equal(factor(evidence, 'liquidity_usd').value, 150000);
  });
});

describe('unsafe contract safety: the stored failedChecks decide, nothing is rescored', () => {
  test('a failed fact is a hard failure; the other present facts passed their stored checks', () => {
    const row = stored({}, report({creatorBalance: 150_000_000})); // 15% of supply
    assert.equal(row.snapshot.contractSafety.status, 'unsafe');
    const evidence = evidenceOf(row);
    assert.equal(factor(evidence, 'creator_holding').status, 'fails_check');
    assert.equal(factor(evidence, 'creator_holding').value, 15);
    assert.equal(factor(evidence, 'mint_authority').status, 'within_check');
    assert.deepEqual(evidence.hardFailures, row.snapshot.contractSafety.failedChecks);
  });

  test('the combined holder check never claims which of its two limits failed', () => {
    const evidence = evidenceOf(stored({}, report({topHolders: [{pct: 30}, {pct: 5}]})));
    assert.equal(factor(evidence, 'largest_holder').status, 'recorded');
    assert.equal(factor(evidence, 'top_holders').status, 'recorded');
    assert.equal(factor(evidence, 'largest_holder').value, 30);
    assert.ok(evidence.hardFailures.some(message => message.startsWith('Holder concentration too high')));
  });

  test('a stored failure message it does not recognize is still a hard failure, and then no other fact is claimed to pass', () => {
    const row = stored();
    row.snapshot.contractSafety = {...row.snapshot.contractSafety, status: 'unsafe', failedChecks: ['A check worded by some other model version.']};
    const evidence = evidenceOf(row);
    assert.deepEqual(evidence.hardFailures, ['A check worded by some other model version.']);
    for (const id of contractIds) assert.equal(factor(evidence, id).status, 'recorded', id);
  });

  test('an unsafe record with no usable messages still shows a hard failure and never infers a pass', () => {
    const row = stored();
    row.snapshot.contractSafety = {...row.snapshot.contractSafety, status: 'unsafe', failedChecks: 'not-an-array'};
    const evidence = evidenceOf(row);
    assert.deepEqual(evidence.hardFailures, ['Contract safety checks failed.']);
    for (const id of contractIds) assert.notEqual(factor(evidence, id).status, 'within_check', id);
  });

  // Current thresholds are never applied to old facts. A fact above today's creator limit, stored as
  // verified by whatever model recorded it, keeps its stored classification.
  test('a stored verified result keeps its stored classification, even if today’s limit would judge the fact differently', () => {
    const row = stored();
    row.snapshot.contractSafety.facts = {...row.snapshot.contractSafety.facts, creatorHoldingsPct: 40};
    const evidence = evidenceOf(row);
    assert.equal(factor(evidence, 'creator_holding').status, 'within_check');
    assert.equal(factor(evidence, 'creator_holding').value, 40);
    assert.deepEqual(evidence.hardFailures, []);
  });
});

describe('unavailable contract safety', () => {
  test('non-rejected: every contract fact is not measured and the reason says the record cannot tell why', () => {
    const row = stored({}, report({topHolders: []})); // one fact missing, none failed -> unavailable
    assert.equal(row.snapshot.contractSafety.status, 'unavailable');
    const evidence = evidenceOf(row);
    assert.equal(evidence.safety.unavailableReason, 'not_checked_or_incomplete');
    assert.equal(evidence.safety.reportAt, null);
    for (const id of contractIds) {
      assert.equal(factor(evidence, id).status, 'not_measured', id);
      assert.equal(factor(evidence, id).value, null, id);
    }
    assert.ok(evidence.notVerified.some(line => line.includes('cannot tell which')));
  });

  test('rejected: the reason says RugCheck only runs for candidates that pass the hard gates', () => {
    const evidence = evidenceOf(stored({liquidity: {usd: 10000}}, null));
    assert.equal(evidence.state, 'REJECTED');
    assert.equal(evidence.safety.unavailableReason, 'not_checked_rejected');
    assert.equal(factor(evidence, 'liquidity_usd').status, 'fails_check');
    assert.ok(evidence.hardFailures.some(line => line.startsWith('Liquidity below')));
  });
});

describe('classification comes from the stored assessment', () => {
  test('hard gates by category: safety/manipulation are hard failures, data is not verified, momentum is a flag', () => {
    const noSells = evidenceOf(stored({txns: {h1: {buys: 40, sells: 0}}}, null));
    assert.equal(factor(noSells, 'sells_h1').status, 'fails_check');
    assert.equal(factor(noSells, 'sells_h1').value, 0);
    assert.ok(noSells.hardFailures.some(line => line.startsWith('Buys but no sells')));
    const noAge = evidenceOf(stored({pairCreatedAt: undefined}, null));
    assert.equal(factor(noAge, 'pool_age_minutes').status, 'not_measured');
    assert.ok(noAge.notVerified.includes('Pool creation time is unavailable.'));
    assert.equal(noAge.hardFailures.length, 0);
  });

  test('a rejection with an unrecognized category is never softened into a flag', () => {
    const row = stored();
    row.assessment = {...row.assessment, state: 'REJECTED', rejections: [{id: 'future_gate', message: 'A future gate rejected this.'}]};
    assert.deepEqual(evidenceOf(row).hardFailures, ['A future gate rejected this.']);
  });

  test('blockers and failed risk checks keep their stored wording; the contract blocker is not repeated', () => {
    const row = stored(cases.overheated, null);
    const evidence = evidenceOf(row);
    assert.ok(evidence.flags.includes('OVERHEATED is a risk state, not an entry pattern.'));
    assert.ok(evidence.flags.some(line => line.includes('More than 50% rise in one hour')));
    assert.equal(evidence.notVerified.filter(line => line.includes('fails closed')).length, 0);
  });

  test('hard failures do not require unsafe contract safety: market gates are failures on their own', () => {
    const evidence = evidenceOf(stored({liquidity: {usd: 10000}}, null));
    assert.equal(evidence.safety.status, 'unavailable');
    assert.ok(evidence.hardFailures.length > 0);
  });

  test('another model version is shown as stored, with no reclassification', () => {
    const row = stored();
    row.assessment = {...row.assessment, modelVersion: 'momentum-v1.0.0', risks: ['An old-model risk.']};
    const evidence = evidenceOf(row);
    assert.equal(evidence.modelVersion, 'momentum-v1.0.0');
    assert.ok(evidence.flags.includes('An old-model risk.'));
  });
});

describe('missing and malformed input', () => {
  test('market cap missing with FDV present is not measured; FDV is never substituted', () => {
    const evidence = evidenceOf(stored({marketCap: undefined}));
    assert.equal(factor(evidence, 'market_cap_usd').status, 'not_measured');
    assert.equal(factor(evidence, 'market_cap_usd').value, null);
    assert.equal(factor(evidence, 'fdv_usd').value, 800000);
  });

  test('no cached X sample is not measured, never zero', () => {
    const evidence = evidenceOf(stored());
    assert.deepEqual(factor(evidence, 'x_distinct_authors'), {id: 'x_distinct_authors', value: null, status: 'not_measured', source: 'x_cache', asOf: null});
  });

  for (const [label, snapshot, assessment] of [['null', null, null], ['corrupt string', '{not json', '{'], ['empty objects', {}, {}], ['array', [], []], ['number', 42, 42]]) {
    test(`${label} input never throws and never claims a pass`, () => {
      const evidence = reviewEvidence(snapshot, assessment);
      assert.equal(evidence.safety.status, 'unavailable');
      assert.deepEqual(evidence.factors.map(item => item.id), [...FACTOR_IDS]);
      for (const item of evidence.factors) assert.ok(item.status === 'not_measured' || item.status === 'recorded', item.id);
      assert.equal(evidence.factors.some(item => item.status === 'within_check'), false);
    });
  }

  test('a verified record without facts keeps its status but shows no fact as within check', () => {
    const evidence = reviewEvidence({observedAt: NOW, contractSafety: {status: 'verified', source: 'rugcheck', checkedAt: REPORT_AT}}, {});
    assert.equal(evidence.safety.status, 'verified');
    for (const id of contractIds) assert.equal(factor(evidence, id).status, 'not_measured', id);
  });
});

describe('allow-list', () => {
  test('exact keys, and no provider score, risk list, description or raw facts object', () => {
    const evidence = evidenceOf(stored({}, report({creatorBalance: 150_000_000})));
    assert.deepEqual(Object.keys(evidence).sort(), ['factors', 'flags', 'hardFailures', 'marketObservedAt', 'modelVersion', 'notVerified', 'readable', 'safety', 'state', 'version']);
    assert.deepEqual(Object.keys(evidence.safety).sort(), ['reportAt', 'status', 'unavailableReason']);
    for (const item of evidence.factors) assert.deepEqual(Object.keys(item).sort(), ['asOf', 'id', 'source', 'status', 'value']);
    const json = JSON.stringify(evidence);
    for (const leak of ['providerRisks', 'providerScoreNormalized', 'PROVIDER-AUTHORED', 'Mutable metadata', '"facts"', 'failedChecks', 'checkedAt', 'score_normalised']) {
      assert.equal(json.includes(leak), false, leak);
    }
  });

  test('messages are length-bounded', () => {
    const row = stored();
    row.assessment = {...row.assessment, risks: ['x'.repeat(5000)]};
    assert.ok(evidenceOf(row).flags.every(line => line.length <= 300));
  });
});

describe('identity and provider text (release reconciliation)', () => {
  test('a stored snapshot for another mint or pool is never shown as this record\'s evidence', () => {
    const {snapshot, assessment} = stored();
    const own = reviewEvidence(snapshot, assessment, {address: snapshot.address, pair: snapshot.pair});
    assert.equal(own.readable, true);
    for (const identity of [{address: 'OtherMint', pair: snapshot.pair}, {address: snapshot.address, pair: 'OtherPool'}]) {
      const evidence = reviewEvidence(snapshot, assessment, identity);
      assert.equal(evidence.readable, false);
      assert.equal(evidence.marketObservedAt, null);
      assert.equal(evidence.safety.status, 'unavailable');
      assert.ok(evidence.factors.every(factor => factor.status === 'not_measured' && factor.value === null));
    }
  });

  test('a danger-level provider risk name never reaches the client, in the badge or the review view', async () => {
    const {contractSafetySummary} = await import('../lib/goldmine/snapshot.ts');
    const {snapshot, assessment} = stored({}, report({risks: [{name: 'PROVIDER RISK NAME', level: 'danger', description: 'x'}]}));
    assert.equal(snapshot.contractSafety.status, 'unsafe');
    assert.ok(snapshot.contractSafety.failedChecks.some(m => m.includes('PROVIDER RISK NAME')), 'storage keeps the full message');
    const evidence = reviewEvidence(snapshot, assessment, snapshot);
    const summary = contractSafetySummary(snapshot.contractSafety);
    for (const served of [evidence, summary]) assert.equal(JSON.stringify(served).includes('PROVIDER RISK NAME'), false);
    assert.ok(evidence.hardFailures.includes('RugCheck reports a danger-level risk.'));
    assert.match(summary.reason, /RugCheck reports a danger-level risk\./);
  });
});
