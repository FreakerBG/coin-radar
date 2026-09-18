// Goldmine snapshot normalization and Momentum Score v2 (lib/goldmine/snapshot.ts, lib/goldmine/score.ts).
import assert from 'node:assert/strict';
import {describe, mock, test} from 'node:test';
import {addresses} from './helpers/harness.mjs';
import {NOW, cases, checkScoringModel, freshSocial, gateCases, pair, verified} from './helpers/goldmine-fixtures.mjs';

const snapshots = await import('../lib/goldmine/snapshot.ts');
const model = await import('../lib/goldmine/score.ts');
const {bestPoolSnapshots, snapshotFromPair, socialEvidence} = snapshots;
const {DISCLAIMER, MODEL_VERSION, STATES, scoreCandidate} = model;
const snapshot = (overrides, extra = {}) => ({...snapshotFromPair(pair(overrides), NOW), ...extra});

test('the scoring model meets its contract', () => {
  checkScoringModel(model, snapshots);
});

describe('snapshot normalization', () => {
  test('keeps Solana pools with valid token and pair addresses only', () => {
    assert.ok(snapshotFromPair(pair(), NOW));
    for (const overrides of [{chainId: 'ethereum'}, {pairAddress: 'short'}, {pairAddress: undefined}, {baseToken: {address: 'not base58 0OIl'}}, {baseToken: {address: 42}}]) {
      assert.equal(snapshotFromPair(pair(overrides), NOW), null, JSON.stringify(overrides));
    }
    for (const value of [null, undefined, 'text', 7, []]) assert.equal(snapshotFromPair(value, NOW), null);
  });

  test('parses every window and records provenance', () => {
    const s = snapshot();
    assert.deepEqual([s.schema, s.source, s.observedAt, s.address, s.pair, s.dexId, s.symbol], [1, 'dexscreener', NOW, addresses.tokenA, addresses.pairA, 'raydium', 'FIX']);
    assert.deepEqual([s.priceUsd, s.liquidityUsd, s.marketCapUsd, s.fdvUsd, s.ageMinutes], [0.01, 150000, 800000, 800000, 2880]);
    assert.deepEqual(s.volumeUsd, {m5: 30000, h1: 150000, h6: 300000, h24: 600000});
    assert.deepEqual(s.txns.h1, {buys: 120, sells: 60});
    assert.deepEqual(s.priceChangePct, {m5: 3, h1: 25, h6: 40, h24: 60});
    assert.deepEqual([s.promoted, s.social, s.contractSafety], [false, null, {status: 'unavailable', source: null}]);
  });

  test('turns malformed, negative and implausible values into missing data', () => {
    const s = snapshot({
      priceUsd: '-1', liquidity: {usd: Number.POSITIVE_INFINITY}, marketCap: '', fdv: {},
      volume: {m5: -5, h1: 'NaN', h6: '1e3', h24: null},
      txns: {h1: {buys: 2.5, sells: '7'}, h6: {buys: -1, sells: 3}},
      priceChange: {m5: -150, h1: '12.5', h6: Number.NaN, h24: -100},
    });
    assert.deepEqual([s.priceUsd, s.liquidityUsd, s.marketCapUsd, s.fdvUsd], [null, null, null, null]);
    assert.deepEqual(s.volumeUsd, {m5: null, h1: null, h6: 1000, h24: null});
    assert.deepEqual([s.txns.h1, s.txns.h6], [{buys: null, sells: 7}, {buys: null, sells: 3}]);
    assert.deepEqual(s.priceChangePct, {m5: null, h1: 12.5, h6: null, h24: -100});
  });

  test('a pool timestamp in the future is missing, not a brand-new pool', () => {
    assert.equal(snapshot({pairCreatedAt: NOW + 3600000}).ageMinutes, null);
    assert.equal(snapshot({pairCreatedAt: NOW + 60000}).ageMinutes, 0, 'small clock skew is tolerated');
  });

  test('records promotion and link counts, and never marks contract safety verified', () => {
    const s = snapshot({boosts: {active: 3}, info: {websites: [{url: 'https://a.test'}], socials: [{}, {}]}});
    assert.deepEqual([s.promoted, s.links], [true, {websites: 1, socials: 2}]);
    assert.equal(snapshotFromPair(pair(), NOW, true).promoted, true);
    assert.equal(snapshotFromPair(pair({contractSafety: {status: 'verified'}}), NOW).contractSafety.status, 'unavailable');
  });

  test('keeps the highest-liquidity pool per token; a pool without liquidity ranks last', () => {
    const other = {pairAddress: addresses.pairA2};
    const chosen = bestPoolSnapshots([pair({...other, liquidity: undefined}), pair({liquidity: {usd: 90000}}), pair({...other, liquidity: {usd: 95000}}),
      pair({pairAddress: addresses.pairB, baseToken: {address: addresses.tokenB}}), {chainId: 'ethereum'}], NOW, new Set([addresses.tokenB]));
    assert.deepEqual(chosen.map(s => [s.address, s.pair, s.promoted]), [[addresses.tokenA, addresses.pairA2, false], [addresses.tokenB, addresses.pairB, true]]);
  });

  test('reads cached X evidence only when it is well-formed', () => {
    assert.deepEqual(socialEvidence({summary: {sampleSize: 20, uniqueAuthors: 15, duplicateText: 1}}, NOW), {sampleSize: 20, uniqueAuthors: 15, duplicateText: 1, fetchedAt: NOW});
    for (const [data, fetchedAt] of [[null, NOW], [{}, NOW], [{summary: {sampleSize: 'twenty', uniqueAuthors: 1, duplicateText: 0}}, NOW],
      [{summary: {sampleSize: 5, uniqueAuthors: 6, duplicateText: 0}}, NOW], [{summary: {sampleSize: 5, uniqueAuthors: 1, duplicateText: 0}}, 'yesterday']]) {
      assert.equal(socialEvidence(data, fetchedAt), null, JSON.stringify(data));
    }
  });
});

describe('Momentum Score v2', () => {
  test('is versioned and exposes the six states', () => {
    assert.equal(MODEL_VERSION, 'momentum-v2.0.0');
    assert.deepEqual([...STATES], ['EARLY', 'BUILDING', 'BREAKOUT', 'OVERHEATED', 'DISTRIBUTION', 'REJECTED']);
    assert.equal(scoreCandidate(snapshot()).modelVersion, MODEL_VERSION);
  });

  test('is deterministic: the same snapshot gives the same assessment at any time', () => {
    const s = snapshot({}, {social: freshSocial});
    const first = scoreCandidate(s);
    mock.timers.enable({apis: ['Date'], now: NOW + 30 * 86400000});
    try {
      assert.deepEqual(scoreCandidate(structuredClone(s)), first);
    } finally {
      mock.timers.reset();
    }
  });

  test('fails closed without contract safety: no provider-built snapshot is ever an opportunity', () => {
    for (const [name, overrides] of Object.entries({...cases, ...gateCases})) {
      for (const extra of [{}, {social: freshSocial}]) {
        const assessment = scoreCandidate(snapshot(overrides, extra));
        assert.equal(assessment.opportunity, false, name);
        if (assessment.state !== 'REJECTED') assert.ok(assessment.blockers.some(gate => gate.id === 'contract_safety_unverified'), name);
      }
    }
  });

  test('explains every component, rejection and blocker', () => {
    for (const [name, overrides] of Object.entries({...cases, ...gateCases})) {
      const a = scoreCandidate(snapshot(overrides));
      assert.equal(a.components.length, 6, name);
      for (const part of a.components) assert.ok(part.evidence.length > 0 && part.label, `${name} ${part.id}`);
      assert.equal(a.rejections.length > 0, a.state === 'REJECTED', name);
      if (a.state === 'REJECTED') assert.equal(a.blockers.length, 0, name);
      for (const gate of [...a.rejections, ...a.blockers]) assert.ok(a.summary.includes(gate.message), `${name}: ${gate.id} is explained in the summary`);
      assert.ok(a.summary.startsWith(`${a.state} · score ${a.score}/100.`), name);
      assert.equal(a.disclaimer, DISCLAIMER);
    }
    const buyers = scoreCandidate(snapshot()).components.find(part => part.id === 'buyer_pressure');
    assert.ok(buyers.evidence.includes('Counts are swap transactions, not unique wallets.'));
  });

  test('lists observed risks from the safety component', () => {
    assert.deepEqual(scoreCandidate(snapshot()).risks, []);
    assert.deepEqual(scoreCandidate(snapshot(cases.overheated)).risks, ['More than 50% rise in one hour: elevated reversal risk (-3).']);
    assert.equal(scoreCandidate(snapshot(cases.allRisks)).risks.length, 7);
  });

  test('never claims a profit, a guarantee or a recommendation to buy', () => {
    const text = JSON.stringify(Object.values({...cases, ...gateCases}).flatMap(overrides => [scoreCandidate(snapshot(overrides)), scoreCandidate(snapshot(overrides, verified))]));
    assert.doesNotMatch(text.replaceAll(DISCLAIMER, ''), /guarante|profit|buy now|sure thing|can't lose|risk-free/i);
    assert.match(DISCLAIMER, /not an executable price, a prediction or financial advice/);
  });

  test('resists inflated inputs: implausible turnover and one-sided flow earn nothing extra', () => {
    const wash = scoreCandidate(snapshot({volume: {h24: 150000 * 40}}));
    assert.ok(wash.components.find(part => part.id === 'liquidity_volume').evidence.some(line => line.includes('outside the plausible')));
    assert.ok(wash.score < scoreCandidate(snapshot()).score);
    const oneSided = scoreCandidate(snapshot({txns: {h1: {buys: 175, sells: 5}}}));
    assert.ok(oneSided.components.find(part => part.id === 'buyer_pressure').points < scoreCandidate(snapshot()).components.find(part => part.id === 'buyer_pressure').points);
    assert.ok(oneSided.risks.some(line => line.startsWith('One-sided buy flow')));
  });
});
