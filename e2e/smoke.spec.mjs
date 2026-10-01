// Dashboard smoke checks. All API responses are local fixtures and every non-local
// request is aborted, so these checks never reach DEX Screener, CoinDesk or X.
import {expect, test} from '@playwright/test';

const coin = {
  address: 'TokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', name: 'Fixture Coin', symbol: 'FIXA',
  price: 0.5, change5m: 1, change1h: 12, change24h: 4, liquidity: 150000, volume: 250000, marketCap: 1000000,
  buys: 30, sells: 10, ageHours: 48, pair: 'PairAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', boosted: false,
  score: 92, verdict: 'Research candidate', reasons: ['At least $25k of reported pool liquidity.'], risks: [], links: [],
};
const market = {coins: [coin], asOf: '2026-01-01T00:00:00.000Z', source: 'DEX Screener', warnings: [], coverage: 'Fixture coverage.', cacheSeconds: 60};

const goldmineCandidate = (overrides = {}) => ({
  modelVersion: 'momentum-v2.1.0', address: coin.address, pair: coin.pair, symbol: coin.symbol,
  observedAt: Date.parse('2026-01-01T00:00:00.000Z'), priceUsd: coin.price, score: 81, state: 'BREAKOUT', opportunity: true,
  components: [{id: 'safety_risk', label: 'Safety risk', points: 7, max: 15, status: 'scored', evidence: ['Contract safety verified by rugcheck (+7).']}],
  rejections: [], blockers: [], risks: [], summary: 'BREAKOUT · score 81/100. Passes every gate.', disclaimer: 'Research signal only, not financial advice.',
  snapshot: {contractSafety: {status: 'verified', source: 'rugcheck'}, promoted: false},
  ...overrides,
});
const goldmineChecked = (overrides = {}) => ({
  status: 'checked', modelVersion: 'momentum-v2.1.0', asOf: '2026-01-01T00:00:00.000Z', candidates: [], opportunities: 0,
  warnings: [], coverage: 'Fixture coverage.', disclaimer: 'Research signal only, not financial advice.',
  ...overrides,
});
// The cadence block the panel reads, matching lib/goldmine/cadence.ts: four legacy intraday horizons that a
// once-daily scan cannot evaluate, and three active daily-snapshot targets that it can.
const HOUR = 3600000, DAY = 24 * HOUR;
const horizon = (id, label, targetMs, graceWindowMs, active) => ({
  id, label, description: label + ' fixture.', schedule: active ? 'daily-snapshot-v1' : 'intraday-v0',
  active, targetMs, graceWindowMs, latestObservableAgeMs: targetMs + graceWindowMs, observableUnderCadence: active,
});
const cadence = () => ({
  cronExpression: '0 0 * * *', scanCadenceMs: DAY, schedulerJitterMs: 59 * 60000,
  maxScanGapMs: DAY + 59 * 60000, minScanGapMs: DAY - 59 * 60000,
  observationGraceMs: 26 * HOUR, observationGraceBufferMs: 61 * 60000,
  evaluationScheduleVersion: 'daily-snapshot-v1', legacyEvaluationScheduleVersion: 'intraday-v0',
  exactTargetBoundaryNote: 'Never guaranteed to be exactly the target age.',
  horizons: [
    horizon('15m', '15m (legacy)', 15 * 60000, 5 * 60000, false),
    horizon('1h', '1h (legacy)', HOUR, 15 * 60000, false),
    horizon('6h', '6h (legacy)', 6 * HOUR, HOUR, false),
    horizon('24h', '24h (legacy)', 24 * HOUR, 3 * HOUR, false),
    horizon('d1', '1-day target', DAY, 26 * HOUR, true),
    horizon('d3', '3-day target', 3 * DAY, 26 * HOUR, true),
    horizon('d7', '7-day target', 7 * DAY, 26 * HOUR, true),
  ],
});
const goldmineTracking = (overrides = {}) => ({modelVersion: 'momentum-v2.1.0', evaluationScheduleVersion: 'daily-snapshot-v1', cadence: cadence(), signals: [], stats: [], disclaimer: 'Research signal only, not financial advice.', ...overrides});
const emptyCoverage = () => ({pending: 0, expiredUnswept: 0, observed: 0, unavailable: 0, missed: 0});
const emptyDistribution = () => ({count: 0, mean: null, median: null, stdev: null});
const denominatorGroup = (signals, observedReturns) => ({signals, coverage: {...emptyCoverage(), observed: observedReturns}, observedReturns});
const goldmineBacktest = (overrides = {}) => ({
  modelVersion: 'momentum-v2.1.0', evaluationScheduleVersion: 'daily-snapshot-v1', cadence: cadence(),
  generatedAt: Date.parse('2026-01-08T00:00:00.000Z'),
  totals: {signals: 0, opportunities: 0, control: 0, strategy: 0},
  denominators: {control: denominatorGroup(0, 0), strategy: denominatorGroup(0, 0), opportunity: denominatorGroup(0, 0)},
  totalSignals: 0, skippedMalformedRows: 0, skippedMalformedOutcomes: 0, truncated: false,
  replay: {
    currentVersionSignals: 0, matched: 0, mismatchedCount: 0, mismatchedSample: [], mismatchedSampleTruncated: false,
    unsupportedCount: 0, unsupportedModelVersions: [], invalidCount: 0,
  },
  performance: [], calibration: null, limitations: ['Research signal only, not financial advice.'], disclaimer: 'Research signal only, not financial advice.',
  ...overrides,
});

async function mockApis(page, overrides = {}) {
  const responses = {
    market: {status: 200, json: market},
    news: {status: 200, json: {items: [], asOf: '2026-01-01T00:00:00.000Z'}},
    social: {status: 200, json: {status: 'not_connected', posts: [], message: 'X is not connected.', configured: false, usedToday: 0, dailyLimit: 0}},
    portfolio: {status: 401, json: {error: 'Sign in to load your research account.'}},
    advisor: {status: 401, json: {error: 'Sign in required.'}},
    monitor: {status: 401, json: {error: 'Sign in required.'}},
    // The topbar sign-in control reads this. Anonymous by default, matching the other fixtures.
    'auth:session': {status: 200, json: {signedIn: false, signInPath: '/login?return_to=%2F'}},
    goldmine: {status: 200, json: goldmineTracking()},
    'goldmine:backtest': {status: 200, json: goldmineBacktest()},
    ...overrides,
  };
  await page.context().route(url => !['localhost', '127.0.0.1'].includes(url.hostname), route => route.abort());
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const name = url.pathname.split('/')[2];
    const sub = url.pathname.split('/')[3];
    const key = sub ? `${name}:${sub}` : (name === 'goldmine' && route.request().method() === 'POST' ? 'goldmine:post' : name);
    const response = responses[key] ?? responses[name];
    return response ? route.fulfill(response) : route.fulfill({status: 404, json: {error: 'No fixture.'}});
  });
}

const tab = (page, name) => page.getByRole('tab', {name});
// Interact only after the client has hydrated and rendered the market fixture.
async function openDashboard(page) {
  await page.goto('/');
  await expect(page.getByRole('button', {name: 'View score explanation for FIXA'})).toBeVisible();
}

test('Stage 09: near misses stay collapsed and research-only; missing facts are explicit', async ({page}) => {
  const evidence = {
    market:{source:'dexscreener',checkedAt:1000,liquidityUsd:0,marketCapUsd:null,volume1hUsd:100,buys1h:0,sells1h:5,promoted:false},
    contract:{source:null,checkedAt:null,mintAuthorityRenounced:null,freezeAuthorityRenounced:null,lpLockedPct:null,topHolderPct:null,topHoldersPct:null,creatorHoldingsPct:null,insiderNetworksDetected:null,rugged:null},
  };
  const signal={id:'miss',address:coin.address,pair:coin.pair,symbol:'MISS',state:'BUILDING',score:70,opportunity:false,
    detectedAt:'2026-01-01T00:00:00Z',detectedPrice:coin.price,contractSafety:{status:'unavailable'},reviewEvidence:evidence,assessment:{summary:'Safety unavailable.'},outcomes:[]};
  const writes=[];
  await mockApis(page,{goldmine:{status:200,json:goldmineTracking({signals:[signal]})}});
  page.on('request',r=>{if(r.method()==='POST')writes.push(r.url());});
  await openDashboard(page);await tab(page,'Goldmine').click();
  const misses=page.locator('.near-misses');await expect(misses).not.toHaveAttribute('open','');
  await misses.locator('summary').first().click();
  await expect(misses).toContainText('Safety unavailable.');
  await expect(misses.getByRole('link')).toHaveCount(0);
  await expect(misses.getByRole('button',{name:/Plan in Advisor/})).toHaveCount(0);
  await misses.locator('.stored-evidence summary').click();
  await expect(misses).toContainText('Unknown');await expect(misses).toContainText('0 USD');
  await expect(misses).toContainText('Observation time unknown');expect(writes).toEqual([]);
});

test('Stage 09: manual observations never create a position, and reset with the target', async ({page}) => {
  const writes=[];
  await mockApis(page,{goldmine:{status:200,json:goldmineTracking({signals:[{id:'review',address:coin.address,pair:'PairBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',symbol:'REVIEW',state:'BREAKOUT',score:81,opportunity:true,detectedAt:'2026-01-01T00:00:00Z',detectedPrice:coin.price,contractSafety:{status:'verified'},assessment:{summary:'Fixture.'},outcomes:[]}]})}});
  page.on('request',r=>{if(r.method()==='POST')writes.push(r.url());});
  await openDashboard(page);await tab(page,'Goldmine').click();
  await page.getByRole('button',{name:/Plan in Advisor: REVIEW/}).click();
  const review=page.getByRole('region',{name:'Live manual review before recording a fill'});
  await expect(review).toContainText('5 unknown');
  await review.getByRole('radio',{name:'Manually reviewed'}).first().check();
  await expect(review).toContainText('4 unknown');
  await review.getByRole('radio',{name:'Blocker found'}).nth(1).check();
  await expect(review).toContainText('Manual blocker recorded');
  expect(writes).toEqual([]);
  await page.getByRole('button',{name:'Use my Discover selection instead'}).click();
  await expect(review).toContainText('5 unknown');await expect(review).toContainText('0 blocked');
});

test('Stage 09: six tabs do not widen the page at intermediate viewport widths', async ({page}) => {
  await mockApis(page);await openDashboard(page);
  for(const width of [390,600,640,768,900]){
    await page.setViewportSize({width,height:900});
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);
    expect(overflow,`page overflow at ${width}px`).toBe(false);
  }
});

test('initial dashboard renders market fixtures', async ({page}) => {
  await mockApis(page);
  await openDashboard(page);
  await expect(page.getByRole('heading', {name: 'Catch the signal.'})).toBeVisible();
  await expect(page.getByRole('heading', {name: 'Market radar'})).toBeVisible();
});

test('Axiom setup is a manual guide with documented fields and no trading request', async ({page}) => {
  const posts = [];
  await mockApis(page);
  page.on('request', request => { if (request.method() === 'POST') posts.push(request.url()); });
  await openDashboard(page);
  await tab(page, 'Axiom setup').click();
  await expect(page.getByRole('heading', {name: 'Set up Axiom Pulse'})).toBeVisible();
  await expect(page.getByRole('rowheader', {name: 'Dev Holding %'})).toBeVisible();
  await expect(page.getByRole('rowheader', {name: 'Market Cap ($)'})).toBeVisible();
  await expect(page.getByText('The observed Pulse screen mixed SOL and ETH cards even in Migrated;', {exact:false})).toBeVisible();
  await expect(page.getByRole('link', {name: /Open Axiom Pulse/})).toHaveAttribute('href', 'https://axiom.trade/pulse');
  await expect(page.getByText('Coin Radar cannot change your Axiom settings or place orders.')).toBeVisible();
  expect(posts).toEqual([]);
});

test('full-loss planner caps spend and never sends a trade', async ({page}) => {
  const posts = [];
  await mockApis(page);
  page.on('request', request => { if (request.method() === 'POST') posts.push(request.url()); });
  await openDashboard(page);
  await tab(page, 'Axiom setup').click();
  await expect(page.getByRole('heading', {name: 'Full-loss trade planner'})).toBeVisible();
  await page.getByRole('spinbutton', {name: /Speculative trading budget/}).fill('1000');
  await page.getByRole('spinbutton', {name: /Live exact-pool liquidity/}).fill('50000');
  await expect(page.getByText('Full-loss budget is binding.')).toBeVisible();
  await expect(page.getByText('$4.45', {exact:true})).toBeVisible();
  await page.getByRole('spinbutton', {name: /Maximum full loss of budget/}).fill('0.01');
  await expect(page.getByText('Estimated fixed costs use the entire loss budget; skip this setup.')).toBeVisible();
  expect(posts).toEqual([]);
});

test('provider outage shows an unavailable state', async ({page}) => {
  await mockApis(page, {market: {status: 502, json: {coins: [], asOf: null, error: 'Market provider unavailable. Retry shortly; no trading signals are being generated.'}}});
  await page.goto('/');
  await expect(page.getByRole('alert').filter({hasText: 'Market provider unavailable'})).toBeVisible();
  await expect(page.getByRole('heading', {name: 'Feed unavailable'})).toBeVisible();
});

test('switches between Discover, Watchlist, Goldmine, Advisor and Alerts', async ({page}) => {
  await mockApis(page);
  await openDashboard(page);
  await tab(page, 'Watchlist').click();
  await expect(page.getByRole('heading', {name: 'Your watchlist', exact: true})).toBeVisible();
  await tab(page, 'Goldmine').click();
  await expect(page.getByRole('heading', {name: 'Goldmine', exact: true})).toBeVisible();
  await tab(page, 'Advisor').click();
  await expect(page.getByRole('heading', {name: 'Advisor & position control'})).toBeVisible();
  await tab(page, 'Alerts').click();
  await expect(page.getByRole('heading', {name: 'Watchlist alerts'})).toBeVisible();
  await tab(page, 'Discover').click();
  await expect(page.getByRole('heading', {name: 'Market radar'})).toBeVisible();
});

test('Goldmine: backtesting section degrades gracefully with too few recorded signals', async ({page}) => {
  await mockApis(page);
  await openDashboard(page);
  await tab(page, 'Goldmine').click();
  await expect(page.getByRole('heading', {name: 'Backtesting & calibration'})).toBeVisible();
  await expect(page.getByRole('heading', {name: 'Not enough recorded signals yet'})).toBeVisible();
});

const populatedBacktest = (overrides = {}) => {
  // One active daily-snapshot bucket with an honest elapsed-observation distribution (observed about two
  // days after detection, not at the 24-hour target), and one legacy bucket that the current cadence could
  // never evaluate: almost entirely missed, with a pending row whose window has already closed.
  const performance = [
    {
      modelVersion: 'momentum-v2.1.0', state: 'BREAKOUT', horizon: 'd1', horizonLabel: '1-day target',
      horizonSchedule: 'daily-snapshot-v1', horizonActive: true, observableUnderCadence: true, targetHours: 24,
      coverage: {pending: 1, expiredUnswept: 0, observed: 12, unavailable: 0, missed: 0},
      returnsPct: {count: 12, mean: 4.2, median: 3.1, stdev: 6.5}, positiveShare: 0.6,
      observedAfterHours: {count: 12, mean: 47.2, median: 47.2, stdev: 0.4},
    },
    {
      modelVersion: 'momentum-v2.1.0', state: 'BREAKOUT', horizon: '15m', horizonLabel: '15m (legacy)',
      horizonSchedule: 'intraday-v0', horizonActive: false, observableUnderCadence: false, targetHours: 0.25,
      coverage: {pending: 0, expiredUnswept: 3, observed: 0, unavailable: 0, missed: 9},
      returnsPct: emptyDistribution(), positiveShare: null, observedAfterHours: emptyDistribution(),
    },
  ];
  const cell = (id, label, active, overrides2 = {}) => ({
    horizon: id, horizonLabel: label, horizonSchedule: active ? 'daily-snapshot-v1' : 'intraday-v0',
    horizonActive: active, observableUnderCadence: active, targetHours: active ? 24 : 0.25,
    eligible: 4, coverage: {...emptyCoverage(), observed: 4}, coverageRatio: 1, eligibleWithOutcome: 4,
    returnsPct: {count: 4, mean: 2, median: 1, stdev: 3}, positiveShare: 0.5,
    cellStatus: 'insufficient', sufficientEvidence: false, observedAfterHours: {count: 4, mean: 47.2, median: 47.2, stdev: 0.4},
    ...overrides2,
  });
  const calibration = {
    modelVersion: 'momentum-v2.1.0', excludedOtherVersionSignals: 0,
    cutoffAt: Date.parse('2026-01-01T00:00:00.000Z'), referenceCount: 6, evaluationCount: 6,
    sufficientCellCount: 0, insufficientCellCount: 2, notEvaluableCellCount: 40, totalCellCount: 42, descriptiveOnly: true,
    rows: [{threshold: 60, eligibleCount: 4, byHorizon: [cell('15m', '15m (legacy)', false), cell('d1', '1-day target', true)]}],
  };
  return goldmineBacktest({
    totalSignals: 12,
    totals: {signals: 87, opportunities: 0, control: 60, strategy: 27},
    denominators: {control: denominatorGroup(60, 40), strategy: denominatorGroup(27, 12), opportunity: denominatorGroup(0, 0)},
    replay: {currentVersionSignals: 12, matched: 12, mismatchedCount: 0, mismatchedSample: [], mismatchedSampleTruncated: false, unsupportedCount: 0, unsupportedModelVersions: [], invalidCount: 0},
    performance, calibration, ...overrides,
  });
};

test('Goldmine: backtesting section shows a performance and calibration report once there is enough history', async ({page}) => {
  await mockApis(page, {'goldmine:backtest': {status: 200, json: populatedBacktest()}});
  await openDashboard(page);
  await tab(page, 'Goldmine').click();
  await expect(page.getByRole('heading', {name: 'Backtesting & calibration'})).toBeVisible();
  await expect(page.getByText('12 valid signals analyzed.')).toBeVisible();
  await expect(page.getByText('BREAKOUT').first()).toBeVisible();
  await expect(page.getByText('momentum-v2.1.0').first()).toBeVisible();
  await expect(page.getByText('Score threshold sweep (descriptive only) - model momentum-v2.1.0')).toBeVisible();
  await expect(page.getByText('Descriptive only: at least one evaluable cell', {exact: false})).toBeVisible();
  await expect(page.getByText('insufficient evidence', {exact: false}).first()).toBeVisible();
});

// Stage 06: the facts that make the recorded outcome evidence honest have to be visible on the page, not
// only present in the API response.
test.describe('Goldmine: the dashboard states the cadence limits plainly', () => {
  test('the once-daily cadence and the daily-snapshot meaning of the active horizons are stated', async ({page}) => {
    await mockApis(page, {'goldmine:backtest': {status: 200, json: populatedBacktest()}});
    await openDashboard(page);
    await tab(page, 'Goldmine').click();
    await expect(page.getByText('scans once a day', {exact: false})).toBeVisible();
    await expect(page.getByText('first daily scan at or after its target age', {exact: false})).toBeVisible();
    await expect(page.getByText('not exact-time execution prices', {exact: false})).toBeVisible();
    await expect(page.getByText('Evaluation schedule daily-snapshot-v1', {exact: false})).toBeVisible();
  });

  test('legacy intraday horizons are named as unevaluable under this cadence', async ({page}) => {
    await mockApis(page, {'goldmine:backtest': {status: 200, json: populatedBacktest()}});
    await openDashboard(page);
    await tab(page, 'Goldmine').click();
    await expect(page.getByText('cannot be evaluated by a once-daily scan', {exact: false})).toBeVisible();
    // Including the 6h horizon the earlier documentation omitted.
    await expect(page.getByText('15m, 1h, 6h, 24h', {exact: false})).toBeVisible();
    await expect(page.getByText('legacy, not observable on this cadence').first()).toBeVisible();
  });

  test('expired-unswept coverage is labeled as a closed window, not as live pending work', async ({page}) => {
    await mockApis(page, {'goldmine:backtest': {status: 200, json: populatedBacktest()}});
    await openDashboard(page);
    await tab(page, 'Goldmine').click();
    await expect(page.getByText('3 expired-unswept (window closed, not live pending)', {exact: false})).toBeVisible();
  });

  test('the actual elapsed observation duration is visible next to the return', async ({page}) => {
    await mockApis(page, {'goldmine:backtest': {status: 200, json: populatedBacktest()}});
    await openDashboard(page);
    await tab(page, 'Goldmine').click();
    await expect(page.getByText('47.2h after detection').first()).toBeVisible();
    await expect(page.getByText('active daily snapshot').first()).toBeVisible();
  });

  test('zero opportunities across all recorded history is stated plainly, with separate control and strategy denominators', async ({page}) => {
    await mockApis(page, {'goldmine:backtest': {status: 200, json: populatedBacktest()}});
    await openDashboard(page);
    await tab(page, 'Goldmine').click();
    await expect(page.getByText('0 opportunities across all 87 recorded signals', {exact: false})).toBeVisible();
    await expect(page.getByText('That is a result, not missing data', {exact: false})).toBeVisible();
    await expect(page.getByText('60 REJECTED control signals (40 observed returns)', {exact: false})).toBeVisible();
    await expect(page.getByText('27 actionable-state signals (12 observed)', {exact: false})).toBeVisible();
    await expect(page.getByText('says nothing about how the candidates that cleared every gate performed', {exact: false})).toBeVisible();
  });

  test('the cadence explanation is shown even below the "not enough data" threshold', async ({page}) => {
    // This is exactly when an owner asks why everything is missed, so the answer must not hide behind a
    // populated report.
    await mockApis(page, {'goldmine:backtest': {status: 200, json: goldmineBacktest({totalSignals: 2})}});
    await openDashboard(page);
    await tab(page, 'Goldmine').click();
    await expect(page.getByRole('heading', {name: 'Not enough recorded signals yet'})).toBeVisible();
    await expect(page.getByText('scans once a day', {exact: false})).toBeVisible();
    await expect(page.getByText('cannot be evaluated by a once-daily scan', {exact: false})).toBeVisible();
    await expect(page.getByText('Across all recorded history: 0 signals, and so 0 opportunities.', {exact: false})).toBeVisible();
  });
});

test('Goldmine: a truncated/malformed-data report shows an explicit data-quality warning, not a bare "N signals recorded"', async ({page}) => {
  const report = populatedBacktest({totalSignals: 12, truncated: true, skippedMalformedRows: 2, skippedMalformedOutcomes: 1});
  await mockApis(page, {'goldmine:backtest': {status: 200, json: report}});
  await openDashboard(page);
  await tab(page, 'Goldmine').click();
  await expect(page.getByRole('heading', {name: 'Backtesting & calibration'})).toBeVisible();
  await expect(page.getByText('Partial analysis', {exact: false})).toBeVisible();
  await expect(page.getByText('newest valid signals', {exact: false}).first()).toBeVisible();
  await expect(page.getByText('2 stored signal rows failed validation', {exact: false})).toBeVisible();
  await expect(page.getByText('1 stored outcome row failed validation', {exact: false})).toBeVisible();
  // The main summary paragraph must never say a bare "N signals recorded" under a partial-analysis banner.
  await expect(page.getByText('signals recorded.', {exact: false})).toHaveCount(0);
  await expect(page.getByText('12 newest valid signals analyzed from the bounded history.')).toBeVisible();
});

test('Goldmine: complete (non-truncated) report copy stays simple - "N valid signals analyzed", no partial-analysis wording', async ({page}) => {
  await mockApis(page, {'goldmine:backtest': {status: 200, json: populatedBacktest()}});
  await openDashboard(page);
  await tab(page, 'Goldmine').click();
  await expect(page.getByText('12 valid signals analyzed.')).toBeVisible();
  await expect(page.getByText('Partial analysis', {exact: false})).toHaveCount(0);
});

// --- Data-quality warning visibility, independent of hasEnoughData (Opus Medium finding) ------------------
// The banner must render whenever it applies - even when fewer than MIN_SIGNALS_FOR_REPORT (10) valid
// signals remain, even at zero valid signals, and it must never render twice in the populated state.
test.describe('Goldmine: data-quality warning renders in every applicable UI state, not just the populated one', () => {
  test('(a) 3 valid signals + 40 skipped malformed signals + 7 skipped malformed outcomes: warning shows even though there is not enough data for a full report', async ({page}) => {
    const report = goldmineBacktest({totalSignals: 3, skippedMalformedRows: 40, skippedMalformedOutcomes: 7});
    await mockApis(page, {'goldmine:backtest': {status: 200, json: report}});
    await openDashboard(page);
    await tab(page, 'Goldmine').click();
    await expect(page.getByText('failed validation', {exact: false})).toBeVisible();
    await expect(page.getByText('40 stored signal rows failed validation', {exact: false})).toBeVisible();
    await expect(page.getByText('7 stored outcome rows failed validation', {exact: false})).toBeVisible();
    // The "not enough data" message still renders alongside the warning; it does not hide it.
    await expect(page.getByRole('heading', {name: 'Not enough recorded signals yet'})).toBeVisible();
  });

  test('(b) fewer than 10 valid signals, with truncation: warning shows alongside the "not enough data" message', async ({page}) => {
    const report = goldmineBacktest({totalSignals: 4, truncated: true});
    await mockApis(page, {'goldmine:backtest': {status: 200, json: report}});
    await openDashboard(page);
    await tab(page, 'Goldmine').click();
    await expect(page.getByText('Partial analysis', {exact: false})).toBeVisible();
    await expect(page.getByRole('heading', {name: 'Not enough recorded signals yet'})).toBeVisible();
  });

  test('(c) enough valid signals, with a data-quality warning: the warning appears exactly once, not doubled', async ({page}) => {
    const report = populatedBacktest({totalSignals: 12, truncated: true, skippedMalformedRows: 2, skippedMalformedOutcomes: 1});
    await mockApis(page, {'goldmine:backtest': {status: 200, json: report}});
    await openDashboard(page);
    await tab(page, 'Goldmine').click();
    await expect(page.getByRole('status').filter({hasText: 'Partial analysis'})).toHaveCount(1);
  });

  test('(d) enough valid signals, no truncation and no excluded data: no data-quality warning at all', async ({page}) => {
    await mockApis(page, {'goldmine:backtest': {status: 200, json: populatedBacktest()}});
    await openDashboard(page);
    await tab(page, 'Goldmine').click();
    await expect(page.getByRole('heading', {name: 'Backtesting & calibration'})).toBeVisible();
    await expect(page.getByText('Partial analysis', {exact: false})).toHaveCount(0);
    await expect(page.getByText('failed validation', {exact: false})).toHaveCount(0);
  });

  for (const [label, width, height] of [['narrow mobile', 320, 800], ['narrow mobile', 360, 800], ['narrow mobile', 390, 800], ['tablet', 768, 1024], ['desktop', 1440, 900]]) {
    test(`${label} viewport (${width}px): data-quality warning below the "not enough data" threshold has no horizontal page overflow`, async ({page}) => {
      await page.setViewportSize({width, height});
      const report = goldmineBacktest({totalSignals: 3, skippedMalformedRows: 40, skippedMalformedOutcomes: 7});
      await mockApis(page, {'goldmine:backtest': {status: 200, json: report}});
      await openDashboard(page);
      await tab(page, 'Goldmine').click();
      await expect(page.getByText('40 stored signal rows failed validation', {exact: false})).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `Goldmine tab with a below-threshold data-quality warning overflows horizontally by ${overflow}px`).toBeLessThanOrEqual(0);
    });
  }
});

test('Goldmine: idle state before any scan, distinct from an empty result', async ({page}) => {
  await mockApis(page);
  await openDashboard(page);
  await tab(page, 'Goldmine').click();
  await expect(page.getByRole('heading', {name: 'Goldmine', exact: true})).toBeVisible();
  await expect(page.getByText('No scan run yet this session.')).toBeVisible();
  await expect(page.getByRole('heading', {name: 'Scan for opportunities'})).toBeVisible();
  await expect(page.getByRole('heading', {name: 'No opportunities recorded yet'})).toBeVisible();
  const scanButton = page.getByRole('button', {name: 'Scan now'});
  await expect(scanButton).toBeEnabled();
  await scanButton.focus();
  await expect(scanButton).toBeFocused();
});

test('Goldmine: a verified opportunity renders as a card; an empty successful scan never looks like an error', async ({page}) => {
  await mockApis(page, {'goldmine:post': {status: 200, json: goldmineChecked({candidates: [goldmineCandidate()], opportunities: 1})}});
  await openDashboard(page);
  await tab(page, 'Goldmine').click();
  await page.getByRole('button', {name: 'Scan now'}).click();
  await expect(page.getByText('1 verified opportunity found.')).toBeVisible();
  await expect(page.getByText('RugCheck verified')).toBeVisible();
  await expect(page.getByText('BREAKOUT · score 81/100. Passes every gate.')).toBeVisible();

  // A second scan with zero opportunities is an honest empty result, not an error banner.
  await mockApis(page, {'goldmine:post': {status: 200, json: goldmineChecked({candidates: [], opportunities: 0})}});
  await page.getByRole('button', {name: 'Scan now'}).click();
  await expect(page.getByRole('status').getByText('Scanned 0 candidates. None currently pass every safety and momentum gate.')).toBeVisible();
  await expect(page.getByRole('heading', {name: 'No opportunities right now'})).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('opportunity review exposes exact-mint social and holder checks without claiming independent wallets', async ({page}) => {
  await mockApis(page, {'goldmine:post': {status: 200, json: goldmineChecked({candidates: [goldmineCandidate()], opportunities: 1})}});
  await openDashboard(page);
  await tab(page, 'Goldmine').click();
  await page.getByRole('button', {name: 'Scan now'}).click();
  const review = page.getByText('Research socials and wallets before trading');
  await review.click();
  await expect(page.getByText('Coin Radar has no verified follower count or independent-wallet count for this mint.', {exact: false})).toBeVisible();
  await expect(page.getByRole('link', {name: 'Open Solscan holders and flows'})).toHaveAttribute('href', 'https://solscan.io/token/' + coin.address);
  await expect(page.getByRole('link', {name: 'Open RugCheck'})).toHaveAttribute('href', 'https://rugcheck.xyz/tokens/' + coin.address);
  await expect(page.getByRole('link', {name: 'Search the exact mint on X'})).toHaveAttribute('href', 'https://x.com/search?q=' + encodeURIComponent(coin.address) + '&f=live');
});

test('Goldmine: a candidate the backend did not mark opportunity never appears as one', async ({page}) => {
  const rejected = goldmineCandidate({opportunity: false, state: 'REJECTED', score: 20, summary: 'REJECTED. Thin liquidity.', snapshot: {contractSafety: {status: 'unsafe', source: 'rugcheck'}, promoted: false}});
  await mockApis(page, {'goldmine:post': {status: 200, json: goldmineChecked({candidates: [rejected], opportunities: 0})}});
  await openDashboard(page);
  await tab(page, 'Goldmine').click();
  await page.getByRole('button', {name: 'Scan now'}).click();
  await expect(page.getByRole('status').getByText('Scanned 1 candidate. None currently pass every safety and momentum gate.')).toBeVisible();
  const goldminePanel = page.locator('section.panel', {has: page.getByRole('heading', {name: 'Goldmine', exact: true})});
  await expect(goldminePanel.getByText('FIXA')).toHaveCount(0);
});

test('Goldmine: a provider outage and a network failure are distinct, retryable states', async ({page}) => {
  await mockApis(page, {'goldmine:post': {status: 200, json: {status: 'provider_unavailable', modelVersion: 'momentum-v2.1.0', asOf: '2026-01-01T00:00:00.000Z', candidates: [], message: 'Market provider unavailable.'}}});
  await openDashboard(page);
  await tab(page, 'Goldmine').click();
  await page.getByRole('button', {name: 'Scan now'}).click();
  await expect(page.getByRole('status').getByText('Market data provider is unavailable right now. No candidates were scored.')).toBeVisible();
  await expect(page.getByRole('heading', {name: 'Provider unavailable'})).toBeVisible();

  await mockApis(page, {'goldmine:post': {status: 503, json: {error: 'Goldmine scan failed.'}}});
  await page.getByRole('button', {name: 'Scan now'}).click();
  await expect(page.getByRole('alert').filter({hasText: 'Goldmine scan failed.'})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Retry'})).toBeVisible();
});

test('Goldmine: recorded history shows only past verified opportunities, with tracked outcomes', async ({page}) => {
  const signal = {
    id: 'sig-1', address: coin.address, pair: coin.pair, symbol: coin.symbol, state: 'BREAKOUT', score: 81, opportunity: true,
    detectedAt: '2026-01-01T00:00:00.000Z', detectedPrice: coin.price, contractSafety: {status: 'verified', source: 'rugcheck'},
    assessment: {summary: 'BREAKOUT · score 81/100. Passes every gate.'},
    outcomes: [
      {horizon: 'd1', horizonLabel: '1-day target', status: 'observed', state: 'observed', returnPct: 4.2, observedAfterHours: 47.2, targetHours: 24},
      {horizon: 'd3', horizonLabel: '3-day target', status: 'pending', state: 'pending', returnPct: null, observedAfterHours: null, targetHours: 72},
      {horizon: 'd7', horizonLabel: '7-day target', status: 'pending', state: 'expired_unswept', returnPct: null, observedAfterHours: null, targetHours: 168},
    ],
  };
  await mockApis(page, {goldmine: {status: 200, json: goldmineTracking({signals: [signal]})}});
  await openDashboard(page);
  await tab(page, 'Goldmine').click();
  await expect(page.getByRole('heading', {name: 'Recent opportunities'})).toBeVisible();
  // The observed return names the real elapsed time, never the target age alone.
  await expect(page.getByText('1-day target: +4.2% after 47.2h')).toBeVisible();
  await expect(page.getByText('3-day target: pending')).toBeVisible();
  // A pending row whose window has already closed is not shown as live pending work.
  await expect(page.getByText('7-day target: expired-unswept')).toBeVisible();
  await expect(page.getByText('7-day target: pending')).toHaveCount(0);
});

test('Goldmine: signal history unavailable shows a retryable error, not an empty history', async ({page}) => {
  await mockApis(page, {goldmine: {status: 503, json: {error: 'Signal storage unavailable.'}}});
  await openDashboard(page);
  await tab(page, 'Goldmine').click();
  await expect(page.getByRole('alert').filter({hasText: 'Signal storage unavailable.'})).toBeVisible();
  await expect(page.getByRole('heading', {name: 'No opportunities recorded yet'})).toHaveCount(0);
});

test('Goldmine: the scan button is disabled while a scan is in flight, so rapid clicks send only one request', async ({page}) => {
  let postCount = 0;
  await mockApis(page);
  await page.route('**/api/goldmine', async route => {
    if (route.request().method() !== 'POST') return route.fulfill({status: 200, json: goldmineTracking()});
    postCount++;
    await new Promise(resolve => setTimeout(resolve, 400));
    return route.fulfill({status: 200, json: goldmineChecked({candidates: [goldmineCandidate()], opportunities: 1})});
  });
  await openDashboard(page);
  await tab(page, 'Goldmine').click();
  const scanButton = page.getByRole('button', {name: /Scan now|Scanning/});
  await scanButton.click();
  await expect(scanButton).toBeDisabled();
  // Two more clicks while disabled must not queue additional requests.
  await scanButton.click({force: true});
  await scanButton.click({force: true});
  await expect(page.getByText('1 verified opportunity found.')).toBeVisible();
  expect(postCount).toBe(1);
});

test('Goldmine: a slower, earlier history fetch never overwrites a faster, later one (stale-response race)', async ({page}) => {
  await mockApis(page, {goldmine: {status: 503, json: {error: 'Signal storage unavailable.'}}});
  await openDashboard(page);
  await tab(page, 'Goldmine').click();
  await expect(page.getByRole('alert').filter({hasText: 'Signal storage unavailable.'})).toBeVisible();

  const oldSignal = {
    id: 'sig-old', address: coin.address, pair: coin.pair, symbol: 'OLDD', state: 'BREAKOUT', score: 81, opportunity: true,
    detectedAt: '2026-01-01T00:00:00.000Z', detectedPrice: coin.price, contractSafety: {status: 'verified'},
    assessment: {summary: 'stale response'}, outcomes: [],
  };
  const newSignal = {
    id: 'sig-new', address: coin.address, pair: coin.pair, symbol: 'NEWW', state: 'BREAKOUT', score: 81, opportunity: true,
    detectedAt: '2026-01-01T00:00:00.000Z', detectedPrice: coin.price, contractSafety: {status: 'verified'},
    assessment: {summary: 'fresh response'}, outcomes: [],
  };
  let call = 0;
  await page.route('**/api/goldmine', async route => {
    if (route.request().method() === 'POST') return route.fulfill({status: 200, json: goldmineChecked()});
    call++;
    if (call === 1) { await new Promise(resolve => setTimeout(resolve, 500)); return route.fulfill({status: 200, json: goldmineTracking({signals: [oldSignal]})}); }
    return route.fulfill({status: 200, json: goldmineTracking({signals: [newSignal]})});
  });
  const retry = page.getByRole('button', {name: 'Retry'});
  await retry.click(); // request A: slow, resolves last
  await retry.click(); // request B: fast, resolves first - and is the newer request

  await expect(page.getByText('NEWW')).toBeVisible();
  // Give request A time to resolve after B; its late arrival must never replace the newer result.
  await page.waitForTimeout(700);
  await expect(page.getByText('OLDD')).toHaveCount(0);
  await expect(page.getByText('NEWW')).toBeVisible();
});

test('watchlist and alert settings persist on this device', async ({page}) => {
  await mockApis(page);
  await openDashboard(page);
  await page.getByRole('button', {name: /^Add FIXA .* to watchlist$/}).click();
  await tab(page, 'Alerts').click();
  await page.getByLabel('Minimum hourly change percentage').fill('35');

  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('coin-radar-v1') || '{}').threshold)).toBe(35);
  await page.reload();
  await expect(page.getByRole('button', {name: 'View score explanation for FIXA'})).toBeVisible();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('coin-radar-v1') || '{}'));
  expect(saved.watch).toEqual([coin.address]);
  expect(saved.threshold).toBe(35);
  await expect(page.getByRole('button', {name: /^Remove FIXA .* from watchlist$/})).toBeVisible();
  await tab(page, 'Alerts').click();
  await expect(page.getByLabel('Minimum hourly change percentage')).toHaveValue('35');
});

test('Advisor explains signed-out and unavailable account states', async ({page}) => {
  await mockApis(page);
  await openDashboard(page);
  await tab(page, 'Advisor').click();
  await expect(page.getByRole('alert').filter({hasText: 'Sign in to load your research account.'})).toBeVisible();

  await mockApis(page, {portfolio: {status: 503, json: {error: 'Research storage unavailable. Your saved positions have not been changed.'}}});
  await page.getByRole('button', {name: 'Retry'}).click();
  await expect(page.getByRole('alert').filter({hasText: 'Research storage unavailable.'})).toBeVisible();
});

for (const [label, width, height] of [['narrow mobile', 320, 800], ['narrow mobile', 360, 800], ['narrow mobile', 390, 800], ['tablet', 768, 1024], ['desktop', 1440, 900]]) {
  test(`${label} viewport (${width}px) has no horizontal page overflow`, async ({page}) => {
    await page.setViewportSize({width, height});
    await mockApis(page);
    // Measure with the market table rendered; the wide table must scroll inside its own container.
    await openDashboard(page);
    for (const name of ['Discover', 'Watchlist', 'Goldmine', 'Advisor', 'Alerts']) {
      await tab(page, name).click();
      await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${name} tab overflows horizontally by ${overflow}px`).toBeLessThanOrEqual(0);
    }
  });

  // Same check with a populated backtesting/calibration report: the widest tables on the Goldmine tab
  // (model version + state + horizon + coverage columns) must still scroll inside their own container
  // rather than widening the page itself, at this width.
  test(`${label} viewport (${width}px): populated backtesting report has no horizontal page overflow`, async ({page}) => {
    await page.setViewportSize({width, height});
    await mockApis(page, {'goldmine:backtest': {status: 200, json: populatedBacktest()}});
    await openDashboard(page);
    await tab(page, 'Goldmine').click();
    await expect(page.getByRole('heading', {name: 'Backtesting & calibration'})).toBeVisible();
    await expect(page.getByText('Score threshold sweep (descriptive only) - model momentum-v2.1.0')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `Goldmine tab with a populated backtest report overflows horizontally by ${overflow}px`).toBeLessThanOrEqual(0);
  });

  // The data-quality warning banner (truncated + malformed rows/outcomes) adds content above the tables;
  // it must not cause horizontal overflow either, at any checked width.
  test(`${label} viewport (${width}px): truncated/malformed-data warning has no horizontal page overflow`, async ({page}) => {
    await page.setViewportSize({width, height});
    const report = populatedBacktest({totalSignals: 12, truncated: true, skippedMalformedRows: 2, skippedMalformedOutcomes: 1});
    await mockApis(page, {'goldmine:backtest': {status: 200, json: report}});
    await openDashboard(page);
    await tab(page, 'Goldmine').click();
    await expect(page.getByText('Partial analysis', {exact: false})).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `Goldmine tab with a data-quality warning overflows horizontally by ${overflow}px`).toBeLessThanOrEqual(0);
  });
}

// The Vercel deployment shipped app/login/page.tsx with nothing linking to it and no way to sign
// out: every data route answered 401 and the page offered no affordance to fix that. These cover
// the control that makes sign-in reachable and sign-out possible.
test('an anonymous visitor gets a sign-in link in the topbar that points at /login', async ({page}) => {
  await mockApis(page);
  await openDashboard(page);
  const signIn = page.getByRole('link', {name: 'Sign in'});
  await expect(signIn).toBeVisible();
  await expect(signIn).toHaveAttribute('href', /^\/login\?return_to=/);
  await expect(page.getByRole('button', {name: 'Sign out'})).toHaveCount(0);
});

test('a signed-in owner gets a sign-out control instead, and no identity is rendered', async ({page}) => {
  await mockApis(page, {'auth:session': {status: 200, json: {signedIn: true, signInPath: null}}});
  await openDashboard(page);
  await expect(page.getByRole('button', {name: 'Sign out'})).toBeVisible();
  await expect(page.getByRole('link', {name: 'Sign in'})).toHaveCount(0);
  // Nothing identifying is shown: the session endpoint never returns a user id or email.
  await expect(page.getByText('owner@vercel.local')).toHaveCount(0);
});

// Server-rendered content only. The interactive behaviour of this form (typing enables the submit
// button, a rejected password shows the server's message) is covered against the real Vercel build
// artifact rather than here: the vinext dev server this suite runs against serves /login's markup but
// does not hydrate it, so a click here would test the dev server, not the page. The deployed Vercel
// build does hydrate it - see docs/deployment-runbook.md section 10, "Known limitation".
test('the sign-in page is served and shows the owner sign-in form', async ({page}) => {
  await mockApis(page);
  await page.goto('/login');
  await expect(page.getByRole('heading', {name: 'Owner sign-in'})).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
  await expect(page.getByRole('button', {name: 'Sign in'})).toBeVisible();
  // No identity, no hint about whether a password is configured, and nothing private on an
  // unauthenticated page.
  await expect(page.getByText('Single-owner private tool.')).toBeVisible();
});

// The Goldmine panel's scan status reflects only this browser session. Everything below covers the
// storage-backed "most recent recorded signals" line, which is the only place an unattended scheduled
// scan (Vercel Cron, once a day) becomes visible to the owner at all.
test.describe('Goldmine: the most recent recorded batch is visible without running a scan', () => {
  const recordedBatch = (overrides = {}) => ({
    detectedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    signalCount: 28, opportunityCount: 0,
    byState: [{state: 'EARLY', count: 5}, {state: 'BUILDING', count: 3}, {state: 'REJECTED', count: 20}],
    ...overrides,
  });

  test('a recorded batch with no opportunities reads as a result, not as "no scan has run"', async ({page}) => {
    await mockApis(page, {goldmine: {status: 200, json: goldmineTracking({latest: recordedBatch()})}});
    await openDashboard(page);
    await tab(page, 'Goldmine').click();
    // Rendered on load: no "Scan now" was pressed anywhere in this test.
    await expect(page.getByText('28 signals recorded, none met every safety and momentum gate.')).toBeVisible();
    await expect(page.getByText('5 EARLY · 3 BUILDING · 20 REJECTED')).toBeVisible();
    await expect(page.getByText('That is a result, not a missing scan.')).toBeVisible();
    await expect(page.getByText('No signals have been recorded yet')).toHaveCount(0);
  });

  test('nothing recorded at all is stated as such, and never as a scheduler failure', async ({page}) => {
    await mockApis(page, {goldmine: {status: 200, json: goldmineTracking({latest: null})}});
    await openDashboard(page);
    await tab(page, 'Goldmine').click();
    await expect(page.getByText('No signals have been recorded yet on this deployment.')).toBeVisible();
    await expect(page.getByText('That is a result, not a missing scan.')).toHaveCount(0);
  });

  test('a gap longer than the daily scan interval is called out, without asserting a cause', async ({page}) => {
    const stale = recordedBatch({detectedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()});
    await mockApis(page, {goldmine: {status: 200, json: goldmineTracking({latest: stale})}});
    await openDashboard(page);
    await tab(page, 'Goldmine').click();
    await expect(page.getByText(/Nothing new recorded in over 26 hours/)).toBeVisible();
    await expect(page.getByText(/finds nothing new to record also leaves this unchanged/)).toBeVisible();
  });

  test('a recent batch is reported without any staleness note', async ({page}) => {
    await mockApis(page, {goldmine: {status: 200, json: goldmineTracking({latest: recordedBatch()})}});
    await openDashboard(page);
    await tab(page, 'Goldmine').click();
    await expect(page.getByText('28 signals recorded, none met every safety and momentum gate.')).toBeVisible();
    await expect(page.getByText(/Nothing new recorded in over 26 hours/)).toHaveCount(0);
  });
});

// --- Manual trading handoff ---------------------------------------------------------------------------------
// A Goldmine opportunity leads to a trading app and, separately, to the Advisor for the same exact mint and
// pool. Opening a trading app never records anything; only the manual form with an actual fill does.
const HANDOFF_MINT = 'TokenBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const HANDOFF_POOL = 'PairBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const recordedSignal = (overrides = {}) => ({
  id: 'sig-handoff', address: HANDOFF_MINT, pair: HANDOFF_POOL, symbol: 'GOLDB', state: 'BREAKOUT', score: 81, opportunity: true,
  detectedAt: '2026-01-01T00:00:00.000Z', detectedPrice: 0.25, contractSafety: {status: 'verified', source: 'rugcheck'},
  assessment: {summary: 'BREAKOUT · score 81/100. Passes every gate.'}, outcomes: [],
  ...overrides,
});
const signedInPortfolio = {status: 200, json: {
  config: {bankroll: 1000, riskPct: 1, maxAllocationPct: 5, takeProfitPct: 50, stopPct: 20, trailingPct: 15, liquidityDropPct: 30, xDailyRequests: 0},
  positions: [], events: [], monitoring: 'browser_open_only',
}};
const handoffCard = page => page.getByRole('group', {name: 'Manual trade options for GOLDB'});

test.describe('Goldmine: manual trading handoff', () => {
  test('Axiom is the primary action, Phantom secondary, with the full mint and pool shown distinctly', async ({page}) => {
    await mockApis(page, {goldmine: {status: 200, json: goldmineTracking({signals: [recordedSignal()]})}});
    await openDashboard(page);
    await tab(page, 'Goldmine').click();
    const card = handoffCard(page);
    await expect(card.getByTestId('trade-mint')).toHaveText(HANDOFF_MINT);
    await expect(card.getByTestId('trade-pool')).toHaveText(HANDOFF_POOL);
    await expect(card.getByText('Mint (token contract)')).toBeVisible();
    await expect(card.getByText('Detected pool')).toBeVisible();

    const actions = card.locator('.trade-buttons > *');
    await expect(actions.first()).toHaveAccessibleName(/^Review in Axiom: GOLDB/);
    await expect(actions.first()).toHaveClass(/btn-primary/);
    await expect(actions.nth(1)).toHaveAccessibleName(/^Open in Phantom: GOLDB/);
    await expect(actions.nth(1)).not.toHaveClass(/btn-primary/);
    await expect(actions.first()).toHaveAttribute('href', `https://axiom.trade/meme/${HANDOFF_MINT}`);
    await expect(actions.nth(1)).toHaveAttribute('href', `https://phantom.com/tokens/solana/${HANDOFF_MINT}`);
    for (const link of await card.getByRole('link').all()) {
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
    // Desktop: no app-only swap deeplink; the Axiom search fallback is always there.
    await expect(card.getByRole('link', {name: /Swap in Phantom app/})).toHaveCount(0);
    await expect(card.getByRole('link', {name: 'Copy mint and search Axiom ↗'})).toHaveAttribute('href', 'https://axiom.trade/pulse');
    await expect(card.getByText('Price and safety evidence are snapshots from', {exact: false})).toBeVisible();
    await expect(card.getByText('check the live token, contract, liquidity, fees, slippage and order details', {exact: false})).toBeVisible();
    await expect(card.getByText('Opening Axiom or Phantom does not place, record or confirm a trade.', {exact: false})).toBeVisible();
  });

  test('a fresh scan opportunity gets the same handoff block', async ({page}) => {
    await mockApis(page, {'goldmine:post': {status: 200, json: goldmineChecked({candidates: [goldmineCandidate()], opportunities: 1})}});
    await openDashboard(page);
    await tab(page, 'Goldmine').click();
    await page.getByRole('button', {name: 'Scan now'}).click();
    const card = page.getByRole('group', {name: 'Manual trade options for FIXA'});
    await expect(card.getByTestId('trade-mint')).toHaveText(coin.address);
    await expect(card.getByTestId('trade-pool')).toHaveText(coin.pair);
    await expect(card.getByRole('button', {name: /^Plan in Advisor: FIXA/})).toBeVisible();
  });

  test('opening Axiom or Phantom copies the mint for search and records nothing', async ({page, context}) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const portfolioWrites = [];
    await mockApis(page, {goldmine: {status: 200, json: goldmineTracking({signals: [recordedSignal()]})}, portfolio: signedInPortfolio});
    page.on('request', request => { if (request.url().includes('/api/portfolio') && request.method() !== 'GET') portfolioWrites.push(request.url()); });
    await openDashboard(page);
    await tab(page, 'Goldmine').click();
    const card = handoffCard(page);
    const axiomTab = page.waitForEvent('popup');
    await card.getByRole('link', {name: /^Review in Axiom/}).click();
    await (await axiomTab).close();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(HANDOFF_MINT);
    const phantomTab = page.waitForEvent('popup');
    await card.getByRole('link', {name: /^Open in Phantom/}).click();
    await (await phantomTab).close();
    await page.waitForTimeout(500);
    expect(portfolioWrites).toEqual([]);
    await expect(page.getByText('Manual position recorded')).toHaveCount(0);
  });

  test('an invalid stored mint renders no trading links at all', async ({page}) => {
    await mockApis(page, {goldmine: {status: 200, json: goldmineTracking({signals: [recordedSignal({address: 'not-a-mint/../x'})]})}});
    await openDashboard(page);
    await tab(page, 'Goldmine').click();
    await expect(page.getByText('contract address failed validation, so no trading links are shown', {exact: false})).toBeVisible();
    // Scoped to the Goldmine panel: the Research brief sidebar links the (valid) Discover selection.
    const goldminePanel = page.locator('section.panel', {has: page.getByRole('heading', {name: 'Goldmine', exact: true})});
    await expect(goldminePanel.getByRole('link', {name: /Axiom|Phantom/})).toHaveCount(0);
    await expect(goldminePanel.getByRole('button', {name: /Plan in Advisor/})).toHaveCount(0);
  });

  test('recorded opportunities refresh read-only: manual and timed reads are GETs, never a scan', async ({page}) => {
    await page.clock.install({time: new Date('2026-09-29T12:00:00Z')});
    const goldmineRequests = [];
    let signals = [recordedSignal()];
    await mockApis(page);
    await page.route('**/api/goldmine', route => {
      goldmineRequests.push(route.request().method());
      return route.fulfill({status: 200, json: goldmineTracking({signals})});
    });
    await openDashboard(page);
    await tab(page, 'Goldmine').click();
    await expect(page.getByTestId('history-last-updated')).toContainText('List updated');
    await expect(page.getByText('New since this page loaded')).toHaveCount(0);
    const initialReads = goldmineRequests.length;

    // A new opportunity recorded by the scheduler, picked up by the manual button.
    signals = [recordedSignal({id: 'sig-later', symbol: 'LATER', address: 'TokenCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'}), recordedSignal()];
    await page.getByRole('button', {name: /^Refresh list/}).click();
    await expect(page.getByText('New since this page loaded')).toHaveCount(1);
    await expect(page.getByRole('status').filter({hasText: '1 newly recorded opportunity since this page loaded.'})).toBeVisible();
    expect(goldmineRequests.length).toBe(initialReads + 1);

    // The timer rereads after the interval with no click, and the same signal is not announced again.
    await page.clock.fastForward('05:30');
    await expect.poll(() => goldmineRequests.length).toBeGreaterThanOrEqual(initialReads + 2);
    await expect(page.getByText('New since this page loaded')).toHaveCount(1);
    expect(goldmineRequests.every(method => method === 'GET'), `requests: ${goldmineRequests.join(',')}`).toBe(true);
    // No toast or desktop notification is raised for a newly recorded signal.
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
  });

  test('Plan in Advisor hands over the exact mint and pool, and only an entered fill records a position', async ({page}) => {
    const advisorQueries = [];
    const portfolioPosts = [];
    await mockApis(page, {goldmine: {status: 200, json: goldmineTracking({signals: [recordedSignal()]})}, portfolio: signedInPortfolio});
    await page.route('**/api/advisor**', route => {
      const url = new URL(route.request().url());
      advisorQueries.push(Object.fromEntries(url.searchParams));
      return route.fulfill({status: 200, json: {coin: {...coin, address: url.searchParams.get('address'), pair: url.searchParams.get('pair'), symbol: 'GOLDB'}, allocation: {amount: 0, ceiling: 10, reason: 'Review required.', status: 'Review required'}, safety: 'unverified', socialInfluence: 'excluded', asOf: '2026-09-29T12:00:00.000Z'}});
    });
    await page.route('**/api/portfolio', route => {
      if (route.request().method() !== 'POST') return route.fulfill(signedInPortfolio);
      portfolioPosts.push(route.request().postDataJSON());
      return route.fulfill({status: 200, json: {ok: true}});
    });
    await openDashboard(page);
    await tab(page, 'Goldmine').click();
    await handoffCard(page).getByRole('button', {name: /^Plan in Advisor: GOLDB/}).click();

    await expect(tab(page, 'Advisor')).toHaveAttribute('aria-selected', 'true');
    const banner = page.getByRole('region', {name: 'Goldmine signal handed to the Advisor'});
    await expect(banner).toBeFocused();
    await expect(banner.getByTestId('handoff-mint')).toHaveText(HANDOFF_MINT);
    await expect(banner.getByTestId('handoff-pool')).toHaveText(HANDOFF_POOL);
    await expect(banner).toContainText('not a trade recommendation');
    await expect(page.getByRole('heading', {name: 'GOLDB · Entry assessment'})).toBeVisible();
    await expect.poll(() => advisorQueries.at(-1)).toEqual({address: HANDOFF_MINT, pair: HANDOFF_POOL});
    await expect(page.getByTestId('record-target')).toHaveText(`Mint ${HANDOFF_MINT} · Pool ${HANDOFF_POOL}`);

    // Nothing is recorded by the handoff itself, and the form stays disabled until a fill is entered.
    const recordButton = page.getByRole('button', {name: 'Record manual position'});
    await expect(recordButton).toBeDisabled();
    expect(portfolioPosts).toEqual([]);
    await page.getByLabel('Actual fill price · USD').fill('0.0002');
    await expect(recordButton).toBeDisabled();
    await page.getByLabel('Amount spent · USD').fill('25');
    await recordButton.click();
    await expect(page.getByText('Manual position recorded. No trade was executed.')).toBeVisible();
    expect(portfolioPosts).toHaveLength(1);
    expect(portfolioPosts[0]).toMatchObject({action: 'position', position: {address: HANDOFF_MINT, pair: HANDOFF_POOL, symbol: 'GOLDB', entryPrice: 0.0002, amount: 25}});

    // Choosing the Discover selection drops the handoff.
    await page.getByRole('button', {name: 'Use my Discover selection instead'}).click();
    await expect(page.getByRole('heading', {name: 'FIXA · Entry assessment'})).toBeVisible();
    await expect(banner).toHaveCount(0);
  });

  test('selecting a coin in Discover replaces a handed-over Goldmine signal', async ({page}) => {
    await mockApis(page, {goldmine: {status: 200, json: goldmineTracking({signals: [recordedSignal()]})}});
    await openDashboard(page);
    await tab(page, 'Goldmine').click();
    await handoffCard(page).getByRole('button', {name: /^Plan in Advisor/}).click();
    await expect(page.getByRole('heading', {name: 'GOLDB · Entry assessment'})).toBeVisible();
    await tab(page, 'Discover').click();
    await page.getByRole('button', {name: 'View score explanation for FIXA'}).click();
    await tab(page, 'Advisor').click();
    await expect(page.getByRole('heading', {name: 'FIXA · Entry assessment'})).toBeVisible();
    await expect(page.getByRole('region', {name: 'Goldmine signal handed to the Advisor'})).toHaveCount(0);
  });
});

test.describe('Goldmine: manual trading handoff on a phone', () => {
  test.use({
    viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  });

  test('offers the documented Phantom swap link (token prefilled, no amount) and keeps the token page', async ({page}) => {
    await mockApis(page, {goldmine: {status: 200, json: goldmineTracking({signals: [recordedSignal()]})}});
    await openDashboard(page);
    await tab(page, 'Goldmine').click();
    const card = handoffCard(page);
    const swap = card.getByRole('link', {name: /^Swap in Phantom app: GOLDB/});
    await expect(swap).toBeVisible();
    const href = new URL(await swap.getAttribute('href'));
    expect(href.origin + href.pathname).toBe('https://phantom.app/ul/v1/swap/');
    expect([...href.searchParams.keys()]).toEqual(['buy', 'sell']);
    expect(href.searchParams.get('buy')).toBe(`solana:101/address:${HANDOFF_MINT}`);
    await expect(card.getByRole('link', {name: /^Open in Phantom/})).toHaveAttribute('href', `https://phantom.com/tokens/solana/${HANDOFF_MINT}`);
    await expect(card.getByText('you enter the amount and confirm in Phantom', {exact: false})).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `handoff block overflows horizontally by ${overflow}px`).toBeLessThanOrEqual(0);
  });

  for (const width of [320, 360]) {
    test(`${width}px: the handoff block and the Advisor banner fit without horizontal overflow`, async ({page}) => {
      await page.setViewportSize({width, height: 800});
      await mockApis(page, {goldmine: {status: 200, json: goldmineTracking({signals: [recordedSignal()]})}});
      await openDashboard(page);
      await tab(page, 'Goldmine').click();
      await expect(handoffCard(page).getByTestId('trade-mint')).toBeVisible();
      let overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      await handoffCard(page).getByRole('button', {name: /^Plan in Advisor/}).click();
      await expect(page.getByRole('region', {name: 'Goldmine signal handed to the Advisor'})).toBeVisible();
      overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
});
