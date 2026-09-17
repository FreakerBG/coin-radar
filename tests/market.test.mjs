// Market normalization, screening score, warnings and verdicts (lib/market.ts).
import assert from 'node:assert/strict';
import {afterEach, beforeEach, describe, mock, test} from 'node:test';
import {assess, normalize, numeric, safeUrl} from '../lib/market.ts';

const NOW = Date.UTC(2026, 8, 17, 12);
const HOUR = 3600000;

// Scores zero points and raises no risk; override one field to isolate a rule.
const neutral = {liquidity: 25000, volume: 0, change1h: 0, change24h: 0, buys: 0, sells: 0, ageHours: 24};
const NEUTRAL_SCORE = 30; // 15 liquidity + 15 pool age
const scoreOf = overrides => assess({...neutral, ...overrides}).score;
const risksOf = overrides => assess({...neutral, ...overrides}).risks;

const pair = (overrides = {}) => ({
  chainId: 'solana', pairAddress: 'Pair1111111111111111111111111111111111111111',
  baseToken: {address: 'Token111111111111111111111111111111111111111', name: 'Fixture', symbol: 'FIX'},
  priceUsd: '0.5', priceChange: {m5: 1, h1: 2, h24: 3}, liquidity: {usd: 150000}, volume: {h24: 250000}, marketCap: 1e6,
  txns: {h1: {buys: 30, sells: 10}}, pairCreatedAt: NOW - 48 * HOUR,
  ...overrides,
});

describe('input sanitizing', () => {
  test('numeric accepts finite numbers only', () => {
    assert.equal(numeric(0), 0);
    assert.equal(numeric(-2.5), -2.5);
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '5', null, undefined, {}]) {
      assert.equal(numeric(value), null, String(value));
    }
  });

  test('safeUrl accepts HTTPS only', () => {
    assert.equal(safeUrl('https://example.test/a?b=1'), 'https://example.test/a?b=1');
    for (const value of ['http://example.test', 'javascript:alert(1)', 'data:text/html,x', 'ftp://example.test', '//example.test', 'not a url', null, undefined]) {
      assert.equal(safeUrl(value), null, String(value));
    }
  });
});

describe('pair normalization', () => {
  beforeEach(() => mock.timers.enable({apis: ['Date'], now: NOW}));
  afterEach(() => mock.timers.reset());

  test('rejects non-Solana pairs and pairs missing a token address or pair ID', () => {
    assert.equal(normalize(pair({chainId: 'ethereum'})), null);
    assert.equal(normalize(pair({baseToken: {name: 'No address'}})), null);
    assert.equal(normalize(pair({baseToken: undefined})), null);
    assert.equal(normalize(pair({pairAddress: ''})), null);
    assert.equal(normalize(pair({pairAddress: undefined})), null);
    assert.ok(normalize(pair()));
  });

  test('parses a valid price and marks invalid or non-positive prices unavailable', () => {
    assert.equal(normalize(pair({priceUsd: '0.00001234'})).price, 0.00001234);
    for (const priceUsd of ['0', '-1', 'abc', '', undefined, null]) {
      assert.equal(normalize(pair({priceUsd})).price, null, String(priceUsd));
    }
  });

  test('computes pool age from the current time and clamps future timestamps', () => {
    assert.equal(normalize(pair({pairCreatedAt: NOW - 36 * HOUR})).ageHours, 36);
    assert.equal(normalize(pair({pairCreatedAt: NOW + HOUR})).ageHours, 0);
    assert.equal(normalize(pair({pairCreatedAt: undefined})).ageHours, null);
  });

  test('links keep HTTPS URLs and drop unsafe protocols', () => {
    const coin = normalize(pair({info: {
      websites: [{url: 'https://project.test'}, {url: 'javascript:alert(1)'}, {url: 'http://plain.test'}],
      socials: [{type: 'twitter', url: 'https://x.test/project'}, {type: 'telegram', url: 'data:text/html,x'}, {url: 'https://social.test'}],
    }}));
    assert.deepEqual(coin.links, [
      {label: 'Project website · unverified', url: 'https://project.test/'},
      {label: 'twitter · project supplied', url: 'https://x.test/project'},
      {label: 'Social · project supplied', url: 'https://social.test/'},
    ]);
  });

  test('DEX Screener promotion is informational and never changes the research result', () => {
    const plain = normalize(pair());
    const promoted = [normalize(pair(), true), normalize(pair({boosts: {active: 3}}))];
    assert.equal(plain.boosted, false);
    for (const coin of promoted) {
      assert.equal(coin.boosted, true);
      assert.deepEqual([coin.score, coin.verdict, coin.reasons, coin.risks], [plain.score, plain.verdict, plain.reasons, plain.risks]);
    }
  });
});

describe('research score', () => {
  test('neutral fixture scores only liquidity and age, with no risks', () => {
    assert.equal(scoreOf({}), NEUTRAL_SCORE);
    assert.deepEqual(risksOf({}), []);
  });

  test('liquidity: unavailable or below $25k is a risk; $25k scores 15; $100k scores 25', () => {
    assert.match(risksOf({liquidity: null}).join(), /Liquidity is unavailable/);
    assert.match(risksOf({liquidity: 24999.99}).join(), /Thin liquidity/);
    assert.match(risksOf({liquidity: 0}).join(), /Thin liquidity/);
    assert.equal(scoreOf({liquidity: 24999.99}), 15);
    assert.equal(scoreOf({liquidity: 25000}), 30);
    assert.equal(scoreOf({liquidity: 99999.99}), 30);
    assert.equal(scoreOf({liquidity: 100000}), 40);
  });

  test('volume scores 20 at $100k and above', () => {
    assert.equal(scoreOf({volume: 99999.99}), NEUTRAL_SCORE);
    assert.equal(scoreOf({volume: 100000}), NEUTRAL_SCORE + 20);
    assert.equal(scoreOf({volume: null}), NEUTRAL_SCORE);
  });

  test('positive hourly momentum adds its percentage, capped at 20', () => {
    assert.equal(scoreOf({change1h: -5}), NEUTRAL_SCORE);
    assert.equal(scoreOf({change1h: 0}), NEUTRAL_SCORE);
    assert.equal(scoreOf({change1h: 7}), NEUTRAL_SCORE + 7);
    assert.equal(scoreOf({change1h: 20}), NEUTRAL_SCORE + 20);
    assert.equal(scoreOf({change1h: 45}), NEUTRAL_SCORE + 20);
  });

  test('buy bias needs at least 20 hourly transactions and strictly more buys', () => {
    assert.equal(scoreOf({buys: 11, sells: 9}), NEUTRAL_SCORE + 20);
    assert.equal(scoreOf({buys: 10, sells: 9}), NEUTRAL_SCORE, '19 transactions');
    assert.equal(scoreOf({buys: 10, sells: 10}), NEUTRAL_SCORE, 'equal counts');
    assert.equal(scoreOf({buys: 30, sells: null}), NEUTRAL_SCORE);
  });

  test('pool age: unavailable or under 24 hours is a risk; 24 hours scores 15', () => {
    assert.match(risksOf({ageHours: null}).join(), /Pool age is unavailable/);
    assert.match(risksOf({ageHours: 23.99}).join(), /less than 24 hours/);
    assert.equal(scoreOf({ageHours: 23.99}), NEUTRAL_SCORE - 15);
    assert.equal(scoreOf({ageHours: 24}), NEUTRAL_SCORE);
  });

  test('warnings: >50% hourly rise, >30% daily loss, volume >30x liquidity', () => {
    assert.deepEqual(risksOf({change1h: 50}), []);
    assert.match(risksOf({change1h: 50.01}).join(), /elevated reversal risk/);
    assert.deepEqual(risksOf({change24h: -30}), []);
    assert.match(risksOf({change24h: -30.01}).join(), /fallen more than 30%/);
    assert.deepEqual(risksOf({volume: 750000}), [], 'exactly 30x liquidity');
    assert.match(risksOf({volume: 750001}).join(), /Very high volume relative to liquidity/);
  });

  test('maximum score is 100', () => {
    assert.equal(assess({liquidity: 100000, volume: 100000, change1h: 50, change24h: 0, buys: 20, sells: 0, ageHours: 24}).score, 100);
  });

  test('verdict: any risk is High caution; otherwise 65 or more is a Research candidate', () => {
    const strong = {liquidity: 100000, volume: 100000, change1h: 5, change24h: 0, buys: 0, sells: 0, ageHours: 24};
    assert.deepEqual([assess(strong).score, assess(strong).verdict], [65, 'Research candidate']);
    assert.deepEqual([assess({...strong, change1h: 4}).score, assess({...strong, change1h: 4}).verdict], [64, 'Watch']);
    assert.equal(assess({...strong, change1h: 20, buys: 20, ageHours: 23}).verdict, 'High caution', 'risk vetoes a high score');
  });

  test('fractional scores are floored so the displayed score and verdict agree', () => {
    const below = assess({liquidity: 100000, volume: 100000, change1h: 4.99, change24h: 0, buys: 0, sells: 0, ageHours: 24});
    const candidate = assess({liquidity: 100000, volume: 100000, change1h: 5.01, change24h: 0, buys: 0, sells: 0, ageHours: 24});
    assert.deepEqual([below.score, below.verdict], [64, 'Watch']);
    assert.deepEqual([candidate.score, candidate.verdict], [65, 'Research candidate']);
  });
});
