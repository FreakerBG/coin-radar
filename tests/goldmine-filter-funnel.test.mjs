import assert from 'node:assert/strict';
import {test} from 'node:test';
import './helpers/harness.mjs';
const {filterFunnel} = await import('../lib/goldmine/filter-funnel.ts');
const {MODEL_VERSION} = await import('../lib/goldmine/score.ts');

const signal = (id, state, blockers, rejections, safety, opportunity = false, modelVersion = MODEL_VERSION) => ({
  id, modelVersion, snapshot: {contractSafety: {status: safety}},
  assessment: {state, blockers: blockers.map(id => ({id})), rejections: rejections.map(id => ({id})), opportunity},
});

test('explains overlapping gates without claiming safety-only near misses are opportunities', () => {
  const rows = [
    signal('a', 'REJECTED', [], ['thin_liquidity', 'no_sells'], 'unavailable'),
    signal('b', 'BUILDING', ['score_below_threshold', 'contract_safety_unverified'], [], 'unavailable'),
    signal('c', 'BREAKOUT', ['contract_safety_unverified'], [], 'unsafe'),
    signal('d', 'EARLY', [], [], 'verified', true),
    signal('e', 'EARLY', [], [], 'verified', true, 'old-model'),
  ];
  const before = JSON.stringify(rows);
  const result = filterFunnel(rows);
  assert.equal(result.sampledSignals, 4);
  assert.equal(result.excludedOtherVersions, 1);
  assert.deepEqual([result.rejected, result.actionable, result.opportunities, result.safetyOnlyNearMisses], [1, 3, 1, 1]);
  assert.deepEqual(result.safety, {verified: 1, unsafe: 1, unavailable: 2});
  assert.deepEqual(result.rejectionCounts, {thin_liquidity: 1, no_sells: 1});
  assert.deepEqual(result.blockerCounts, {score_below_threshold: 1, contract_safety_unverified: 2});
  assert.equal(JSON.stringify(rows), before, 'diagnosis does not mutate stored evidence');
});
