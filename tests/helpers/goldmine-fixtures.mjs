// Goldmine scoring fixtures and the scoring oracle. The oracle states the model's contract (exact points
// for reference candidates, every hard gate, state rules, fail-closed opportunity status, clamping and
// "missing data never helps": removing inputs never raises a score, makes a state actionable or creates
// an opportunity). tests/goldmine-score.test.mjs runs it against lib/goldmine/score.ts,
// and tests/goldmine-mutation.test.mjs requires it to reject every deliberately broken copy of that file.
import assert from 'node:assert/strict';
import {addresses} from './harness.mjs';

export const NOW = Date.UTC(2026, 8, 18, 12);
const MINUTE = 60000, HOUR = 60 * MINUTE;

// DEX Screener pair shape. The reference is a BREAKOUT scoring 81 without contract safety.
const base = {
  chainId: 'solana', dexId: 'raydium', pairAddress: addresses.pairA,
  baseToken: {address: addresses.tokenA, name: 'Fixture', symbol: 'FIX'},
  priceUsd: '0.01', liquidity: {usd: 150000}, marketCap: 800000, fdv: 800000, pairCreatedAt: NOW - 48 * HOUR,
  volume: {m5: 30000, h1: 150000, h6: 300000, h24: 600000},
  txns: {m5: {buys: 10, sells: 5}, h1: {buys: 120, sells: 60}, h6: {buys: 240, sells: 160}, h24: {buys: 800, sells: 600}},
  priceChange: {m5: 3, h1: 25, h6: 40, h24: 60},
};

// Nested groups merge one level deep; pass a key as undefined to drop it from the provider response.
export function pair(overrides = {}) {
  const merged = {...base, ...overrides};
  for (const key of ['baseToken', 'volume', 'priceChange']) merged[key] = {...base[key], ...overrides[key]};
  merged.txns = {...base.txns, ...overrides.txns};
  for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete merged[key];
  return merged;
}

export const verified = {contractSafety: {status: 'verified', source: 'fixture'}};
export const freshSocial = {sampleSize: 20, uniqueAuthors: 15, duplicateText: 1, fetchedAt: NOW - HOUR};

// Named reference candidates used by the oracle and the unit tests.
export const cases = {
  breakout: {},
  // Age 3 hours and a 5% hourly rise: young, active, not a breakout.
  early: {pairCreatedAt: NOW - 3 * HOUR, priceChange: {h1: 5}},
  // Thin but valid: scores 59 even with verified safety.
  building: {liquidity: {usd: 30000}, volume: {m5: 5000, h1: 60000}, txns: {h1: {buys: 22, sells: 18}}, priceChange: {h1: 3}},
  overheated: {priceChange: {h1: 60}},
  distribution: {txns: {h1: {buys: 30, sells: 70}}, priceChange: {h1: -8}},
  noMomentum: {txns: {h1: {buys: 50, sells: 50}}, priceChange: {h1: -2}},
  lowActivity: {volume: {h1: 1500000}, txns: {h1: {buys: 8, sells: 2}}},
  noValuation: {marketCap: undefined, fdv: undefined},
  noLongVolume: {volume: {h6: undefined}},
  // Every market-observable risk check fails at once: no safety points.
  allRisks: {
    priceChange: {h1: 60, h24: -35}, volume: {h24: 6000000}, txns: {h1: {buys: 180, sells: 20}},
    marketCap: 20000000, fdv: 150000000, pairCreatedAt: NOW - 30 * MINUTE,
  },
};

// Each gate id with a raw pair that must trigger it.
export const gateCases = {
  missing_price: {priceUsd: 'not a price'},
  missing_liquidity: {liquidity: undefined},
  missing_pool_age: {pairCreatedAt: undefined},
  missing_activity: {txns: {h1: {buys: 5}}},
  missing_volume: {volume: {h24: undefined}},
  insufficient_history: {pairCreatedAt: NOW - 10 * MINUTE},
  thin_liquidity: {liquidity: {usd: 20000}},
  sells_absent: {txns: {h1: {buys: 40, sells: 0}}},
  missing_price_change: {priceChange: {m5: undefined}},
  price_collapse: {priceChange: {h1: -45}},
  extreme_turnover: {volume: {h24: 150000 * 150}},
};

// Raw fields removed one at a time for the "missing data never raises a score" rule.
export const removableFields = [
  ['priceChange', 'm5'], ['priceChange', 'h1'], ['priceChange', 'h6'], ['priceChange', 'h24'],
  ['volume', 'm5'], ['volume', 'h1'], ['volume', 'h6'], ['volume', 'h24'],
  ['liquidity', 'usd'], ['marketCap'], ['fdv'], ['pairCreatedAt'],
  ...['m5', 'h1', 'h6', 'h24'].flatMap(window => [['txns', window, 'buys'], ['txns', window, 'sells']]),
];

export function without(raw, path) {
  const copy = structuredClone(raw);
  let node = copy;
  for (const key of path.slice(0, -1)) node = node[key];
  delete node[path.at(-1)];
  return copy;
}

const points = (assessment, id) => assessment.components.find(part => part.id === id).points;
const gateIds = gates => gates.map(gate => gate.id);

// Throws an AssertionError when `model` breaks the scoring contract.
export function checkScoringModel({scoreCandidate}, {snapshotFromPair}) {
  const snapshot = (overrides, extra = {}) => ({...snapshotFromPair(pair(overrides), NOW), ...extra});
  const score = (overrides, extra) => scoreCandidate(snapshot(overrides, extra));

  // Reference candidates: exact points, state and blockers.
  const breakout = score(cases.breakout);
  assert.deepEqual(breakout.components.map(part => [part.id, part.points]), [
    ['liquidity_volume', 18], ['volume_acceleration', 20], ['buyer_pressure', 20], ['age_valuation', 15], ['social_momentum', 0], ['safety_risk', 8],
  ]);
  assert.deepEqual([breakout.score, breakout.state, breakout.opportunity, gateIds(breakout.blockers), breakout.rejections], [81, 'BREAKOUT', false, ['contract_safety_unverified'], []]);
  const confirmed = score(cases.breakout, verified);
  assert.deepEqual([confirmed.score, confirmed.state, confirmed.opportunity, confirmed.blockers], [88, 'BREAKOUT', true, []]);

  const early = score(cases.early, verified);
  assert.deepEqual([early.score, early.state, early.opportunity], [85, 'EARLY', true]);
  const building = score(cases.building, verified);
  assert.deepEqual([building.score, building.state, building.opportunity, gateIds(building.blockers)], [59, 'BUILDING', false, ['score_below_threshold']]);
  const overheated = score(cases.overheated, verified);
  assert.deepEqual([overheated.state, overheated.opportunity, gateIds(overheated.blockers), points(overheated, 'safety_risk')], ['OVERHEATED', false, ['state_not_actionable'], 13]);
  assert.equal(score(cases.distribution, verified).state, 'DISTRIBUTION');
  const quiet = score(cases.noMomentum, verified);
  assert.deepEqual([quiet.state, gateIds(quiet.rejections), quiet.opportunity], ['REJECTED', ['no_qualifying_momentum'], false]);

  // Hard gates reject whatever the points, even with verified contract safety.
  for (const [id, overrides] of Object.entries(gateCases)) {
    const rejected = score(overrides, verified);
    assert.equal(rejected.state, 'REJECTED', id);
    assert.ok(gateIds(rejected.rejections).includes(id), `${id} in ${gateIds(rejected.rejections)}`);
    assert.equal(rejected.opportunity, false, id);
  }
  assert.equal(score({priceChange: {h24: -65}}).state, 'REJECTED', 'a 24h collapse is rejected');
  assert.equal(score({priceChange: {h1: -10, h24: -30}}).rejections.some(gate => gate.id === 'price_collapse'), false, 'a moderate fall is not a collapse');

  // Thin or missing inputs score nothing.
  const low = score(cases.lowActivity);
  for (const id of ['volume_acceleration', 'buyer_pressure']) {
    const part = low.components.find(component => component.id === id);
    assert.deepEqual([id, part.points, part.status], [id, 0, 'unavailable']);
  }
  assert.equal(points(score(cases.noLongVolume), 'volume_acceleration'), 0);
  assert.equal(points(score(cases.noValuation), 'age_valuation'), 8, 'only pool age scores without a valuation');

  // Social: fresh organic evidence counts; stale evidence and paid promotion do not.
  assert.equal(points(score(cases.breakout, {social: freshSocial}), 'social_momentum'), 10);
  assert.equal(points(score(cases.breakout, {social: {...freshSocial, fetchedAt: NOW - 7 * 3600000}}), 'social_momentum'), 0);
  assert.equal(points(score(cases.breakout, {social: freshSocial, promoted: true}), 'social_momentum'), 0);

  // Points stay within each component's range and add up to the score.
  for (const [name, overrides] of Object.entries(cases)) {
    for (const extra of [{}, verified, {social: freshSocial}]) {
      const result = score(overrides, extra);
      for (const part of result.components) assert.ok(part.points >= 0 && part.points <= part.max && Number.isInteger(part.points), `${name} ${part.id} ${part.points}`);
      assert.equal(result.score, result.components.reduce((sum, part) => sum + part.points, 0), name);
    }
  }
  assert.equal(points(score(cases.allRisks), 'safety_risk'), 0);

  // Every risk check must be assessed before a candidate can be an opportunity.
  const unassessed = score({fdv: undefined}, verified);
  assert.deepEqual([unassessed.state, unassessed.opportunity, gateIds(unassessed.blockers)], ['BREAKOUT', false, ['risk_inputs_incomplete']]);
  assert.equal(points(unassessed, 'safety_risk'), 14, 'the unassessed dilution check earns nothing');

  // Missing data never helps: removing any one or two inputs from any reference or risky candidate never
  // raises the score, never turns a risk or rejected state into an entry pattern and never creates an
  // opportunity, with or without verified contract safety.
  for (const [name, overrides] of Object.entries({...cases, ...riskyCases, ...gateCases})) {
    for (const extra of [{}, verified]) {
      const raw = pair(overrides);
      const before = scoreCandidate({...snapshotFromPair(raw, NOW), ...extra});
      for (const paths of removalSets(raw)) {
        const after = scoreCandidate({...snapshotFromPair(paths.reduce(without, raw), NOW), ...extra});
        const label = `${name}${extra.contractSafety ? ' (verified)' : ''} without ${paths.map(path => path.join('.')).join(' and ')}`;
        assert.ok(after.score <= before.score, `${label}: score rose from ${before.score} to ${after.score}`);
        assert.ok(!ACTIONABLE_STATES.includes(after.state) || ACTIONABLE_STATES.includes(before.state), `${label}: ${before.state} became ${after.state}`);
        assert.ok(!after.opportunity || before.opportunity, `${label}: became an opportunity`);
      }
    }
  }
}

const ACTIONABLE_STATES = ['EARLY', 'BUILDING', 'BREAKOUT'];

// Candidates whose risk shows only in inputs that can go missing.
export const riskyCases = {
  overheatedDay: {priceChange: {h24: 400}},
  overheatedMinutes: {priceChange: {m5: 25}},
  decline: {priceChange: {h24: -35}},
  diluted: {marketCap: 1000000, fdv: 6000000},
  oneSided: {txns: {h1: {buys: 175, sells: 5}}},
  heavyTurnover: {volume: {h24: 150000 * 40}},
  thinExit: {marketCap: 20000000, fdv: 20000000},
  young: {pairCreatedAt: NOW - 30 * MINUTE},
};

// Every single removable input, and every pair of them.
function removalSets(raw) {
  const present = removableFields.filter(path => path.reduce((node, key) => node?.[key], raw) !== undefined);
  return [...present.map(path => [path]), ...present.flatMap((first, index) => present.slice(index + 1).map(second => [first, second]))];
}
