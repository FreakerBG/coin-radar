// Position sizing, exit-review rules and social sample summary (lib/advisor.ts).
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {defaultConfig, evaluatePosition, sizePosition, socialSummary} from '../lib/advisor.ts';

const candidate = {verdict: 'Research candidate'};
const budget = (overrides = {}) => ({...defaultConfig, bankroll: 1000, riskPct: 1, maxAllocationPct: 5, ...overrides});
const kinds = result => result.events.map(event => event.kind).sort();

describe('position sizing', () => {
  test('missing, zero, negative or non-finite budget allocates nothing', () => {
    for (const bankroll of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      const result = sizePosition(budget({bankroll}), 0, candidate, true);
      assert.deepEqual([result.amount, result.ceiling, result.status], [0, 0, 'Setup required'], String(bankroll));
    }
  });

  test('no selection, a failed market screen, or no safety review allocates nothing', () => {
    assert.equal(sizePosition(budget(), 0, null, true).amount, 0);
    assert.equal(sizePosition(budget(), 0, null, true).status, 'No selection');
    for (const verdict of ['Watch', 'High caution', '']) {
      assert.equal(sizePosition(budget(), 0, {verdict}, true).amount, 0, verdict);
    }
    const unreviewed = sizePosition(budget(), 0, candidate, false);
    assert.equal(unreviewed.amount, 0);
    assert.equal(unreviewed.status, 'Review required');
    assert.equal(unreviewed.ceiling, 10, 'the ceiling is still shown so the user sees the limit');
  });

  test('a reviewed candidate receives the smallest of the three limits', () => {
    const result = sizePosition(budget(), 0, candidate, true);
    assert.deepEqual([result.amount, result.ceiling, result.status], [10, 10, 'Within your risk limit']);
    assert.equal(sizePosition(budget({riskPct: 2, maxAllocationPct: 10}), 0, candidate, true).amount, 20, 'full-loss percentage limits');
    assert.equal(sizePosition(budget({riskPct: 10, maxAllocationPct: 3}), 0, candidate, true).amount, 30, 'allocation cap limits');
    assert.equal(sizePosition(budget({riskPct: 10, maxAllocationPct: 10}), 950, candidate, true).amount, 50, 'unallocated budget limits');
  });

  test('fully committed or overcommitted accounts cannot add exposure', () => {
    for (const committed of [1000, 1005]) {
      const result = sizePosition(budget(), committed, candidate, true);
      assert.deepEqual([result.amount, result.ceiling, result.status], [0, 0, 'No unallocated budget'], String(committed));
    }
    assert.equal(sizePosition(budget(), 999.995, candidate, true).amount, 0, 'less than one cent available rounds to zero');
  });

  test('allocations round down to whole cents and never exceed the exact limit', () => {
    assert.equal(sizePosition(budget({bankroll: 1234.567}), 0, candidate, true).amount, 12.34);
    for (const bankroll of [29, 57.13, 99.99, 1234.567, 876543.21]) {
      for (const riskPct of [0.1, 1, 3.33, 7]) {
        const exact = bankroll * riskPct / 100;
        const {amount} = sizePosition(budget({bankroll, riskPct, maxAllocationPct: 100}), 0, candidate, true);
        assert.ok(amount <= exact, `${amount} exceeds ${exact}`);
        // Binary floating point can land one cent below an exact cent value; never above.
        assert.ok(exact - amount < 0.0101, `${amount} is more than a cent below ${exact}`);
        assert.equal(Math.round(amount * 100) / 100, amount, 'whole cents only');
      }
    }
  });

  test('settings at their validated boundaries behave consistently', () => {
    // Portfolio API bounds: bankroll <= 1e8, riskPct and maxAllocationPct in [0.1, 100].
    assert.equal(sizePosition(budget({riskPct: 100, maxAllocationPct: 100}), 0, candidate, true).amount, 1000);
    assert.equal(sizePosition(budget({riskPct: 100, maxAllocationPct: 100}), 400, candidate, true).amount, 600);
    assert.equal(sizePosition(budget({riskPct: 0.1, maxAllocationPct: 0.1}), 0, candidate, true).amount, 1);
    assert.equal(sizePosition(budget({bankroll: 1e8, riskPct: 0.1}), 0, candidate, true).amount, 100000);
    assert.equal(sizePosition(budget({bankroll: 0.01, riskPct: 100, maxAllocationPct: 100}), 0, candidate, true).amount, 0.01);
    assert.equal(sizePosition(budget(), 990, candidate, true).amount, 10, 'remaining budget equal to the ceiling');
    assert.equal(sizePosition(budget(), 990.01, candidate, true).amount, 9.99, 'remaining budget one cent below the ceiling');
  });
});

describe('position monitoring', () => {
  // Percentages and prices are exact binary fractions, so each boundary is tested exactly.
  const position = (overrides = {}) => ({
    id: 'p', address: 'a', pair: 'b', symbol: 'T', amount: 100, quantity: 1, openedAt: '', closedAt: null, lastPrice: null, lastCheckedAt: null,
    entryPrice: 100, peakPrice: 100, entryLiquidity: 80000, takeProfitPct: 50, stopPct: 25, trailingPct: 25, liquidityDropPct: 50,
    ...overrides,
  });

  test('loss threshold triggers at and below the threshold price, not above it', () => {
    assert.deepEqual(kinds(evaluatePosition(position(), 75, 80000)), ['loss_threshold'], 'equality triggers');
    assert.deepEqual(kinds(evaluatePosition(position(), 74.99, 80000)), ['loss_threshold']);
    assert.deepEqual(kinds(evaluatePosition(position(), 75.01, 80000)), []);
    assert.equal(evaluatePosition(position(), 75, 80000).events[0].severity, 'urgent');
  });

  test('profit target triggers at and above the target price, not below it', () => {
    assert.deepEqual(kinds(evaluatePosition(position(), 150, 80000)), ['profit_target'], 'equality triggers');
    assert.deepEqual(kinds(evaluatePosition(position(), 150.01, 80000)), ['profit_target']);
    assert.deepEqual(kinds(evaluatePosition(position(), 149.99, 80000)), []);
    assert.equal(evaluatePosition(position(), 150, 80000).events[0].severity, 'review');
  });

  test('trailing pullback triggers at and beyond the pullback from the observed peak', () => {
    const peaked = position({peakPrice: 240, takeProfitPct: 1000});
    assert.deepEqual(kinds(evaluatePosition(peaked, 180, 80000)), ['trailing_pullback'], 'equality triggers');
    assert.deepEqual(kinds(evaluatePosition(peaked, 179.99, 80000)), ['trailing_pullback']);
    assert.deepEqual(kinds(evaluatePosition(peaked, 180.01, 80000)), []);
    assert.equal(evaluatePosition(peaked, 180, 80000).events[0].severity, 'urgent');
  });

  test('trailing pullback needs a peak above entry, so a plain loss is not also a pullback', () => {
    assert.deepEqual(kinds(evaluatePosition(position(), 75, 80000)), ['loss_threshold']);
    assert.deepEqual(kinds(evaluatePosition(position({peakPrice: 240}), 60, 80000)), ['loss_threshold', 'trailing_pullback']);
  });

  test('liquidity drop triggers at and beyond the drop from the opening snapshot', () => {
    assert.deepEqual(kinds(evaluatePosition(position(), 100, 40000)), ['liquidity_drop'], 'equality triggers');
    assert.deepEqual(kinds(evaluatePosition(position(), 100, 0)), ['liquidity_drop']);
    assert.deepEqual(kinds(evaluatePosition(position(), 100, 40000.01)), []);
    assert.deepEqual(kinds(evaluatePosition(position({entryLiquidity: null}), 100, 0)), [], 'no opening snapshot, no drop rule');
    assert.deepEqual(kinds(evaluatePosition(position({entryLiquidity: 0}), 100, 0)), [], 'zero opening snapshot, no drop rule');
  });

  test('unavailable liquidity is a review event while price rules still run', () => {
    const result = evaluatePosition(position(), 75, null);
    assert.deepEqual(kinds(result), ['liquidity_unavailable', 'loss_threshold']);
    assert.equal(result.events.find(event => event.kind === 'liquidity_unavailable').severity, 'review');
  });

  test('unavailable price is urgent, suppresses price rules and preserves the peak', () => {
    for (const price of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = evaluatePosition(position({peakPrice: 240}), price, null);
      assert.deepEqual(kinds(result), ['data_unavailable'], String(price));
      assert.equal(result.events[0].severity, 'urgent');
      assert.equal(result.peak, 240, 'a provider outage cannot reset the high-water mark');
    }
  });

  test('observed peak only rises, and never sits below entry', () => {
    assert.equal(evaluatePosition(position({peakPrice: 120}), 130, 80000).peak, 130);
    assert.equal(evaluatePosition(position({peakPrice: 120}), 110, 80000).peak, 120);
    assert.equal(evaluatePosition(position({peakPrice: 90}), 95, 80000).peak, 100);
  });

  test('ordinary movement produces no event', () => {
    for (const [price, liquidity] of [[100, 80000], [110, 70000], [90, 50000], [149, 41000]]) {
      assert.deepEqual(evaluatePosition(position(), price, liquidity).events, [], `${price} / ${liquidity}`);
    }
  });
});

describe('social sample summary', () => {
  test('empty samples report zeros and keep the manipulation warning', () => {
    const summary = socialSummary([]);
    assert.deepEqual([summary.sampleSize, summary.uniqueAuthors, summary.duplicateText, summary.engagement], [0, 0, 0, 0]);
    assert.match(summary.warning, /not total mentions/);
  });

  test('duplicate text ignores URLs, case and whitespace', () => {
    const summary = socialSummary([
      {text: 'Buy this https://a.test/x', author_id: 'one'},
      {text: '  BUY\n\tthis   http://b.test ', author_id: 'two'},
      {text: 'Buy that', author_id: 'three'},
    ]);
    assert.equal(summary.sampleSize, 3);
    assert.equal(summary.duplicateText, 1);
  });

  test('empty and URL-only posts count as repeated text', () => {
    const summary = socialSummary([{text: 'https://a.test'}, {text: ''}, {text: ' https://b.test/y '}]);
    assert.equal(summary.duplicateText, 2);
  });

  test('unique authors ignore repeats and missing author IDs', () => {
    const summary = socialSummary([
      {text: 'a', author_id: 'one'}, {text: 'b', author_id: 'one'}, {text: 'c', author_id: 'two'},
      {text: 'd'}, {text: 'e', author_id: ''},
    ]);
    assert.equal(summary.uniqueAuthors, 2);
  });

  test('engagement sums likes and reposts, treating missing metrics as zero', () => {
    const summary = socialSummary([
      {text: 'a', public_metrics: {like_count: 5, retweet_count: 2}},
      {text: 'b', public_metrics: {like_count: 3}},
      {text: 'c', public_metrics: {}},
      {text: 'd'},
    ]);
    assert.equal(summary.engagement, 10);
  });
});
