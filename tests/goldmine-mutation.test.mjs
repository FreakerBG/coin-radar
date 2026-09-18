// Mutation checks for Momentum Score v2. Each mutant is a copy of lib/goldmine/score.ts with one rule
// deliberately broken (a gate removed, a threshold moved, fail-closed turned fail-open...). The scoring
// oracle in helpers/goldmine-fixtures.mjs must pass on the real model and reject every mutant; a
// surviving mutant means the tests no longer protect that rule. Each edit must match the source exactly
// once, so a refactor that moves a rule fails here instead of silently testing nothing.
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, describe, test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {checkScoringModel} from './helpers/goldmine-fixtures.mjs';

const source = readFileSync(new URL('../lib/goldmine/score.ts', import.meta.url), 'utf8');
const snapshots = await import('../lib/goldmine/snapshot.ts');
const directory = mkdtempSync(path.join(tmpdir(), 'coin-radar-mutants-'));
after(() => rmSync(directory, {recursive: true, force: true}));

const mutants = {
  'thin-liquidity gate removed': ['if (s.liquidityUsd !== null && s.liquidityUsd < MIN_LIQUIDITY_USD) fail(', 'if (false) fail('],
  'missing price accepted': ["if (s.priceUsd === null) fail('missing_price'", "if (false) fail('missing_price'"],
  'no-sells pattern accepted': ['s.txns.h1.sells === 0) fail(', 's.txns.h1.sells === -1) fail('],
  'collapse threshold inverted': ['(c.h1 !== null && c.h1 <= COLLAPSE_1H_PCT) ||', '(c.h1 !== null && c.h1 >= COLLAPSE_1H_PCT) ||'],
  'wash-trading gate loosened': ['m.turnover > MAX_TURNOVER) fail(', 'm.turnover > MAX_TURNOVER * 10) fail('],
  'contract safety fails open': ["if (s.contractSafety.status !== 'verified') blockers.push(", 'if (false) blockers.push('],
  'score threshold ignored': ['if (score < OPPORTUNITY_MIN_SCORE) blockers.push(', 'if (score < 0) blockers.push('],
  'overheated counted as actionable': ["const ACTIONABLE: CandidateState[] = ['EARLY', 'BUILDING', 'BREAKOUT'];", "const ACTIONABLE: CandidateState[] = ['EARLY', 'BUILDING', 'BREAKOUT', 'OVERHEATED'];"],
  'overheating threshold raised': ['(c.h1 !== null && c.h1 >= 50) ||', '(c.h1 !== null && c.h1 >= 500) ||'],
  'missing 6h volume scores points': ["20, 0, 'unavailable', ['1h or 6h volume is unavailable.']", "20, 10, 'unavailable', ['1h or 6h volume is unavailable.']"],
  'missing valuation scores points': ["if (m.valuation === null) evidence.push(", "if (m.valuation === null) valuationPoints = 7, evidence.push("],
  'too few transactions still accelerate': ['m.h1Total < MIN_FLOW_TXNS) {', 'm.h1Total < 0) {'],
  'buy share from too few transactions': ['h1Total >= MIN_FLOW_TXNS ? h1.buys! / h1Total', 'h1Total > 0 ? h1.buys! / h1Total'],
  'paid promotion counted as social momentum': ['if (s.promoted) return', 'if (false) return'],
  'stale social evidence accepted': ['> SOCIAL_MAX_AGE_MS)', '> SOCIAL_MAX_AGE_MS * 100)'],
  'reversal check passes a 60% hourly rise': ["check('reversal', 2, c.h1, v => v <= 50,", "check('reversal', 2, c.h1, v => v <= 500,"],
  'unassessed risk check earns its points': ['if (check.passed) { points += check.points;', 'if (check.passed || !check.available) { points += check.points;'],
  'contract points granted without evidence': ["else evidence.push('Contract safety (mint", "else points += 7, evidence.push('Contract safety (mint"],
  'missing 5m or 24h change not gated': ['if (s.priceChangePct.m5 === null || s.priceChangePct.h1 === null || s.priceChangePct.h24 === null) fail(', 'if (s.priceChangePct.h1 === null) fail('],
  'incomplete risk inputs do not block': ["if (unassessed.length) blockers.push(", "if (false) blockers.push("],
  'valuation scored without a dilution check': ["else if (m.dilution === null) evidence.push(", "else if (false) evidence.push("],
  // Removing the clamp in component() is an equivalent mutant since v2.1.0: every component's achievable
  // points already equal its maximum and none can go negative. The clamp stays as defense in depth, and
  // the oracle's range check would catch a component that exceeds it.
  'distribution checked after breakout rules': ["if (m.buyShare !== null && m.buyShare <= 0.45 && c.h1 !== null && c.h1 < 0) return 'DISTRIBUTION';", "if (m.buyShare !== null && m.buyShare <= 0.2 && c.h1 !== null && c.h1 < 0) return 'DISTRIBUTION';"],
};

let loaded = 0;
async function load(text) {
  const file = path.join(directory, `score-${loaded++}.ts`);
  writeFileSync(file, text);
  return import(pathToFileURL(file).href);
}

test('the oracle accepts the real model', async () => {
  checkScoringModel(await load(source), snapshots);
});

describe('the oracle rejects every mutant', () => {
  for (const [name, [find, replace]] of Object.entries(mutants)) {
    test(name, async () => {
      assert.equal(source.split(find).length - 1, 1, `the mutated code must occur exactly once in score.ts: ${find}`);
      const mutant = await load(source.replace(find, replace));
      assert.throws(() => checkScoringModel(mutant, snapshots), assert.AssertionError, `mutant survived: ${name}`);
    });
  }
});
