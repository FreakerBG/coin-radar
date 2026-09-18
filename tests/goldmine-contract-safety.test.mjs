// Stage 03B: RugCheck contract-safety evidence (lib/goldmine/contract-safety.ts). RugCheck is a local
// fetch double throughout; nothing here contacts a network, signs anything or sends a credential.
import assert from 'node:assert/strict';
import {beforeEach, describe, test} from 'node:test';
import {addresses, failures, installFetch, offlineFetch} from './helpers/harness.mjs';
import {NOW, pair} from './helpers/goldmine-fixtures.mjs';

const {deriveContractSafety, extractFacts, attachContractSafety, withContractSafety, LP_LOCKED_MIN_PCT, MAX_CHECKS_PER_SCAN, SCAN_BUDGET_MS} = await import('../lib/goldmine/contract-safety.ts');
const {snapshotFromPair} = await import('../lib/goldmine/snapshot.ts');
const {scoreCandidate} = await import('../lib/goldmine/score.ts');

// NOW matches the fixture pairs' own pairCreatedAt/priceChange baseline (tests/helpers/goldmine-fixtures.mjs);
// using any other "current time" as the snapshot's observedAt would desynchronize pool age from the
// fixture and reject the reference BREAKOUT candidate for the wrong reason. contract-safety.ts keeps its
// own module-level cache keyed by address, so testNow (used only as the "now" passed to
// attachContractSafety/withContractSafety, never as the snapshot's observedAt) jumps forward a day
// before every test - the same isolation trick tests/helpers/harness.mjs uses for lib/market.ts's cache -
// so no test ever reuses another test's cached RugCheck response.
let testNow = NOW;
beforeEach(() => { failures.length = 0; testNow += 24 * 3600000; });

const snapshot = (overrides = {}) => snapshotFromPair(pair(overrides), NOW);
const scored = snapshotList => snapshotList.map(s => ({snapshot: s, assessment: scoreCandidate(s)}));

// A realistic populated RugCheck report, shaped exactly like a live GET /v1/tokens/{mint}/report
// response confirmed during the Stage 03B provider preflight (topHolders[].pct, markets[].lp.lpLockedPct,
// creatorBalance as a raw token amount, graphInsidersDetected as a plain number).
function report(overrides = {}) {
  return {
    token: {mintAuthority: null, freezeAuthority: null, supply: 1_000_000_000, decimals: 6},
    rugged: false,
    totalMarketLiquidity: 250000,
    topHolders: [{pct: 8}, {pct: 5}, {pct: 3}],
    creatorBalance: 10_000_000, // 1% of supply
    graphInsidersDetected: 0,
    score_normalised: 5,
    risks: [{name: 'Mutable metadata', level: 'warn', description: 'Token metadata can be changed by the owner'}],
    markets: [{lp: {quoteUSD: 50000, baseUSD: 50000, lpLockedPct: 95}}],
    ...overrides,
  };
}

// A valid, distinct base58 Solana address (no 0/O/I/l) for the nth generated fixture candidate.
const BASE58_SAFE = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const candidateAddress = (label, n) => `${label}${BASE58_SAFE[n % BASE58_SAFE.length]}${'X'.repeat(39 - label.length)}`;

describe('deriveContractSafety: our own deterministic bar over RugCheck facts', () => {
  test('a fully passing report is verified, with every fact preserved', () => {
    const safety = deriveContractSafety(report(), NOW, NOW);
    assert.equal(safety.status, 'verified');
    assert.equal(safety.source, 'rugcheck');
    assert.deepEqual(safety.facts, {
      mintAuthorityRenounced: true, freezeAuthorityRenounced: true, lpLockedPct: 95, totalMarketLiquidityUsd: 250000,
      topHolderPct: 8, topHoldersPct: 16, creatorHoldingsPct: 1, insiderNetworksDetected: 0, rugged: false,
      providerScoreNormalized: 5, providerRisks: [{name: 'Mutable metadata', level: 'warn', description: 'Token metadata can be changed by the owner'}],
    });
  });

  test('mint authority: present is unsafe, renounced (null) is not blocked by it', () => {
    const active = deriveContractSafety(report({token: {...report().token, mintAuthority: 'Auth1111111111111111111111111111111111111'}}), NOW, NOW);
    assert.equal(active.status, 'unsafe');
    assert.ok(active.failedChecks.some(m => m.includes('Mint authority is still active')));
    assert.equal(active.facts.mintAuthorityRenounced, false);
    assert.equal(deriveContractSafety(report(), NOW, NOW).facts.mintAuthorityRenounced, true);
  });

  test('freeze authority: present is unsafe, renounced (null) is not blocked by it', () => {
    const active = deriveContractSafety(report({token: {...report().token, freezeAuthority: 'Auth2222222222222222222222222222222222222'}}), NOW, NOW);
    assert.equal(active.status, 'unsafe');
    assert.ok(active.failedChecks.some(m => m.includes('Freeze authority is still active')));
    assert.equal(deriveContractSafety(report(), NOW, NOW).facts.freezeAuthorityRenounced, true);
  });

  test('LP lock: below the bar is unsafe, at or above it passes', () => {
    const low = deriveContractSafety(report({markets: [{lp: {quoteUSD: 50000, baseUSD: 50000, lpLockedPct: 10}}]}), NOW, NOW);
    assert.equal(low.status, 'unsafe');
    assert.ok(low.failedChecks.some(m => m.includes('Only 10% of LP is locked')));
    const exact = deriveContractSafety(report({markets: [{lp: {quoteUSD: 50000, baseUSD: 50000, lpLockedPct: LP_LOCKED_MIN_PCT}}]}), NOW, NOW);
    assert.equal(exact.status, 'verified');
  });

  test('LP lock is aggregated across every market, not just the largest: a well-locked primary market cannot hide a smaller unlocked one', () => {
    const twoMarkets = report({markets: [
      {lp: {quoteUSD: 60000, baseUSD: 60000, lpLockedPct: 100}}, // the larger, fully-locked market
      {lp: {quoteUSD: 40000, baseUSD: 0, lpLockedPct: 0}}, // a smaller, fully-unlocked market
    ]});
    const safety = deriveContractSafety(twoMarkets, NOW, NOW);
    // 120000 locked out of 160000 total = 75%, below the 80% bar - the old single-market logic would have
    // picked the $120k market (still the largest single one) and reported 100% locked.
    assert.equal(safety.status, 'unsafe');
    assert.equal(safety.facts.lpLockedPct, 75);
    assert.ok(safety.failedChecks.some(m => m.includes('Only 75% of LP is locked')));
  });

  test('LP lock: a market missing lpLockedUSD and lpLockedPct contributes zero locked, never guessed as locked', () => {
    const safety = deriveContractSafety(report({markets: [
      {lp: {quoteUSD: 50000, baseUSD: 50000}}, // no lock field at all
    ]}), NOW, NOW);
    assert.equal(safety.status, 'unsafe');
    assert.equal(safety.facts.lpLockedPct, 0);
  });

  test('rugged: true is always unsafe regardless of every other fact', () => {
    const rugged = deriveContractSafety(report({rugged: true}), NOW, NOW);
    assert.equal(rugged.status, 'unsafe');
    assert.ok(rugged.failedChecks.some(m => m.includes('recorded this contract as rugged')));
  });

  test('a danger-level provider risk blocks verification even when every other check passes', () => {
    const danger = deriveContractSafety(report({risks: [{name: 'Copycat token', level: 'danger', description: 'Mimics a popular token'}]}), NOW, NOW);
    assert.equal(danger.status, 'unsafe');
    assert.ok(danger.failedChecks.some(m => m.includes('danger-level risk: Copycat token')));
    // A warn-level risk (the default fixture) never blocks by itself.
    assert.equal(deriveContractSafety(report(), NOW, NOW).status, 'verified');
  });

  test('creator holdings above the bar is unsafe', () => {
    const heavy = deriveContractSafety(report({creatorBalance: 200_000_000}), NOW, NOW); // 20% of supply
    assert.equal(heavy.status, 'unsafe');
    assert.ok(heavy.failedChecks.some(m => m.includes('Creator holds 20% of supply')));
  });

  test('insider network activity detected is unsafe', () => {
    const insiders = deriveContractSafety(report({graphInsidersDetected: 5}), NOW, NOW);
    assert.equal(insiders.status, 'unsafe');
    assert.ok(insiders.failedChecks.some(m => m.includes('Insider network activity was detected')));
  });

  test('holder concentration: a dominant single holder or a concentrated top set is unsafe', () => {
    const singleHolder = deriveContractSafety(report({topHolders: [{pct: 60}]}), NOW, NOW);
    assert.equal(singleHolder.status, 'unsafe');
    assert.equal(singleHolder.facts.topHolderPct, 60);
    const spreadButConcentrated = deriveContractSafety(report({topHolders: Array.from({length: 10}, () => ({pct: 6}))}), NOW, NOW);
    assert.equal(spreadButConcentrated.status, 'unsafe', 'sums to 60%, over the top-holders bar, though no single holder is dominant');
    assert.equal(spreadButConcentrated.facts.topHolderPct, 6);
  });

  test('holder concentration merges entries by owner: the same wallet split across token accounts cannot evade the single-holder bar', () => {
    const splitWhale = deriveContractSafety(report({topHolders: [
      {pct: 12, owner: 'WhaleOwner1111111111111111111111111111111'},
      {pct: 11, owner: 'WhaleOwner1111111111111111111111111111111'}, // same owner, a second token account
      {pct: 3, owner: 'SmallHolder111111111111111111111111111111'},
    ]}), NOW, NOW);
    // Each entry is individually under the 20% single-holder bar, but the owner's true combined stake
    // (23%) is not, and the summed top-holders total (26%) must reflect the same merge.
    assert.equal(splitWhale.status, 'unsafe');
    assert.equal(splitWhale.facts.topHolderPct, 23);
    assert.equal(splitWhale.facts.topHoldersPct, 26);
  });

  test('holder concentration: entries without an owner field are never merged with each other', () => {
    const safety = deriveContractSafety(report({topHolders: [{pct: 8}, {pct: 5}, {pct: 3}]}), NOW, NOW);
    assert.equal(safety.facts.topHolderPct, 8);
    assert.equal(safety.facts.topHoldersPct, 16);
  });

  test('holder concentration: one entry with an impossible pct invalidates the whole result instead of being silently dropped', () => {
    for (const badPct of [150, -5, Number.POSITIVE_INFINITY, Number.NaN, 'not-a-number']) {
      // A safely-low holder plus one malformed entry: if the malformed entry were simply dropped, the
      // remaining 5% holder would look totally safe - proving the whole fact is invalidated (unavailable,
      // never guessed safe) rather than best-effort computed from just the parseable entries.
      const safety = deriveContractSafety(report({topHolders: [{pct: 5}, {pct: badPct}]}), NOW, NOW);
      assert.equal(safety.status, 'unavailable', JSON.stringify(badPct));
      assert.equal(safety.facts, undefined, JSON.stringify(badPct));
    }
  });

  test('creator holdings: a negative balance is impossible and never computes a passing percentage', () => {
    const safety = deriveContractSafety(report({creatorBalance: -1}), NOW, NOW);
    // Every other check still passes, so an impossible creator balance alone reads as unavailable
    // (unconfirmed), not unsafe - but critically never verified, and never a passing percentage.
    assert.equal(safety.status, 'unavailable');
    assert.equal(safety.facts, undefined);
  });

  test('missing required fields (no token, no rugged) is unavailable, not unsafe', () => {
    assert.equal(extractFacts({}), null);
    assert.equal(deriveContractSafety({}, NOW, NOW).status, 'unavailable');
    assert.equal(deriveContractSafety({token: {mintAuthority: null}}, NOW, NOW).status, 'unavailable', 'rugged is required');
  });

  test('schema drift (wrong types) is unavailable, never crashes, and is never read as safe', () => {
    for (const malformed of [
      {token: 'not-an-object', rugged: false},
      {token: {mintAuthority: null, freezeAuthority: null}, rugged: 'yes'},
      null, 'a string', 42, [],
    ]) {
      assert.equal(deriveContractSafety(malformed, NOW, NOW).status, 'unavailable', JSON.stringify(malformed));
    }
  });

  test('a report with only some facts available (incomplete) is unavailable, distinct from unsafe', () => {
    const thin = deriveContractSafety({token: {mintAuthority: null, freezeAuthority: null}, rugged: false}, NOW, NOW);
    assert.equal(thin.status, 'unavailable');
  });

  test('a stale report is unavailable however good its facts are; a fresh one is not', () => {
    const checkedAt = NOW;
    const fresh = deriveContractSafety(report(), checkedAt, checkedAt + 10 * 60000);
    assert.equal(fresh.status, 'verified');
    const stale = deriveContractSafety(report(), checkedAt, checkedAt + 16 * 60000);
    assert.equal(stale.status, 'unavailable');
  });
});

describe('attachContractSafety: network access, one candidate at a time', () => {
  test('a fully passing response is attached as verified', async () => {
    installFetch(() => Response.json(report()));
    const [result] = await attachContractSafety([snapshot()], testNow);
    assert.equal(result.contractSafety.status, 'verified');
  });

  test('404, 5xx and malformed JSON are all reported and leave contractSafety unavailable, never throwing', async () => {
    for (const respond of [
      () => new Response('not found', {status: 404}),
      () => new Response('down', {status: 503}),
      () => new Response('{not json', {status: 200, headers: {'content-type': 'application/json'}}),
    ]) {
      failures.length = 0;
      testNow += 24 * 3600000; // a fresh address-independent cache window per malformed-response case too
      installFetch(respond);
      const [result] = await attachContractSafety([snapshot()], testNow);
      assert.equal(result.contractSafety.status, 'unavailable');
      assert.deepEqual(failures.map(f => [f.route, f.operation, f.level]), [['goldmine', 'contract-safety', 'warn']]);
    }
  });

  test('a timeout or an aborted request is treated the same as any other provider failure', async () => {
    installFetch(() => { throw new DOMException('The operation was aborted.', 'TimeoutError'); });
    const [result] = await attachContractSafety([snapshot()], testNow);
    assert.equal(result.contractSafety.status, 'unavailable');
    assert.deepEqual(failures.map(f => [f.route, f.operation, f.level]), [['goldmine', 'contract-safety', 'warn']]);
  });

  test('a 429 stops every further request in this call; already-unavailable candidates stay that way', async () => {
    const calls = installFetch(() => new Response('rate limited', {status: 429}));
    const two = [snapshot({baseToken: {address: addresses.tokenA, name: 'A', symbol: 'A'}, pairAddress: addresses.pairA}),
      snapshot({baseToken: {address: addresses.tokenB, name: 'B', symbol: 'B'}, pairAddress: addresses.pairB})];
    const results = await attachContractSafety(two, testNow);
    assert.equal(calls.length, 1, 'the second candidate is never requested once rate-limited');
    assert.deepEqual(results.map(r => r.contractSafety.status), ['unavailable', 'unavailable']);
    assert.deepEqual(failures.map(f => f.operation), ['contract-safety-rate-limited']);
  });

  test('MAX_CHECKS_PER_SCAN bounds requests per call; candidates beyond it stay unavailable, predictably', async () => {
    const calls = installFetch(() => Response.json(report()));
    const many = Array.from({length: MAX_CHECKS_PER_SCAN + 2}, (_, i) => snapshot({
      baseToken: {address: candidateAddress('Cand', i), name: 'X', symbol: 'X'},
      pairAddress: candidateAddress('Pair', i),
    }));
    const results = await attachContractSafety(many, testNow);
    assert.equal(calls.length, MAX_CHECKS_PER_SCAN);
    assert.equal(results.filter(r => r.contractSafety.status === 'verified').length, MAX_CHECKS_PER_SCAN);
    assert.equal(results.filter(r => r.contractSafety.status === 'unavailable').length, 2);
  });

  test('SCAN_BUDGET_MS bounds wall-clock time independent of the `now` used for cache math; candidates past the budget stay unavailable', async () => {
    const calls = installFetch(() => Response.json(report()));
    const two = [snapshot({baseToken: {address: addresses.tokenA, name: 'A', symbol: 'A'}, pairAddress: addresses.pairA}),
      snapshot({baseToken: {address: addresses.tokenB, name: 'B', symbol: 'B'}, pairAddress: addresses.pairB})];
    let ticks = 0;
    // First two clock() reads (the deadline calc, then the first candidate's own check) are still inside
    // the budget; every read after that is past it - simulating real time elapsing mid-scan without
    // depending on an actual sleep.
    const clock = () => (ticks++ < 2 ? 0 : SCAN_BUDGET_MS + 1);
    const results = await attachContractSafety(two, testNow, clock);
    assert.equal(calls.length, 1, 'only the first candidate is requested once the budget is spent');
    assert.deepEqual(results.map(r => r.contractSafety.status), ['verified', 'unavailable']);
  });

  test('never sends a credential, an API key or any header beyond a plain Accept', async () => {
    const seen = [];
    globalThis.fetch = async (input, init = {}) => {
      seen.push({url: String(input), headers: new Headers(init.headers)});
      return Response.json(report());
    };
    await attachContractSafety([snapshot()], testNow);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url.startsWith('https://api.rugcheck.xyz/v1/tokens/'), true);
    assert.equal(seen[0].url, `https://api.rugcheck.xyz/v1/tokens/${addresses.tokenA}/report`, 'the URL is exactly the report endpoint plus the mint address, no query string');
    for (const name of ['authorization', 'x-api-key', 'cookie']) assert.equal(seen[0].headers.has(name), false, name);
  });

  test('a cached report is reused within its TTL (one request for repeated calls); a later call refetches after it expires', async () => {
    const calls = installFetch(() => Response.json(report()));
    const s = snapshot();
    await attachContractSafety([s], testNow);
    await attachContractSafety([s], testNow + 60000); // 1 minute later, well inside the cache TTL
    assert.equal(calls.length, 1, 'the second call is served from cache, not RugCheck again');

    await attachContractSafety([s], testNow + 11 * 60000); // past the cache TTL
    assert.equal(calls.length, 2, 'a report older than the cache TTL is fetched again');
  });
});

describe('withContractSafety: only actionable candidates ever reach RugCheck', () => {
  test('a REJECTED candidate is never sent to RugCheck and keeps contractSafety unavailable', async () => {
    const calls = installFetch(offlineFetch);
    const rejected = snapshot({liquidity: {usd: 100}}); // thin_liquidity gate
    const result = await withContractSafety(scored([rejected]), testNow);
    assert.equal(result[0].assessment.state, 'REJECTED');
    assert.equal(result[0].snapshot.contractSafety.status, 'unavailable');
    assert.equal(calls.length, 0);
  });

  test('an actionable candidate is checked and re-scored with the result', async () => {
    installFetch(() => Response.json(report()));
    const breakout = snapshot();
    const [before] = scored([breakout]);
    assert.equal(before.assessment.state, 'BREAKOUT');
    assert.equal(before.assessment.opportunity, false, 'unverified, as before Stage 03B');

    const [after] = await withContractSafety([before], testNow);
    assert.equal(after.snapshot.contractSafety.status, 'verified');
    assert.equal(after.assessment.opportunity, true, 'Goldmine can now report an opportunity once safety is verified');
    assert.deepEqual(after.assessment.blockers, []);
  });

  test('an unsafe RugCheck result keeps the candidate out of opportunity status, never silently overridden by score', async () => {
    installFetch(() => Response.json(report({rugged: true})));
    const [before] = scored([snapshot()]);
    const [after] = await withContractSafety([before], testNow);
    assert.equal(after.snapshot.contractSafety.status, 'unsafe');
    assert.equal(after.assessment.opportunity, false);
    assert.deepEqual(after.assessment.blockers.map(b => b.id), ['contract_safety_unverified']);
  });
});
