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
const goldmineTracking = (overrides = {}) => ({modelVersion: 'momentum-v2.1.0', signals: [], stats: [], disclaimer: 'Research signal only, not financial advice.', ...overrides});
const goldmineBacktest = (overrides = {}) => ({
  modelVersion: 'momentum-v2.1.0', totalSignals: 0, skippedMalformedRows: 0,
  replay: {currentVersionSignals: 0, matched: 0, mismatched: [], unsupportedCount: 0, unsupportedModelVersions: []},
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

test('initial dashboard renders market fixtures', async ({page}) => {
  await mockApis(page);
  await openDashboard(page);
  await expect(page.getByRole('heading', {name: 'Catch the signal.'})).toBeVisible();
  await expect(page.getByRole('heading', {name: 'Market radar'})).toBeVisible();
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

test('Goldmine: backtesting section shows a performance and calibration report once there is enough history', async ({page}) => {
  const performance = [{modelVersion: 'momentum-v2.1.0', state: 'BREAKOUT', horizon: '15m', coverage: {pending: 0, observed: 12, unavailable: 0, missed: 0}, returnsPct: {count: 12, mean: 4.2, median: 3.1, stdev: 6.5}, positiveShare: 0.6}];
  const calibration = {
    cutoffAt: Date.parse('2026-01-01T00:00:00.000Z'), referenceCount: 6, evaluationCount: 6, descriptiveOnly: true,
    rows: [{threshold: 60, eligibleCount: 4, byHorizon: [{horizon: '15m', eligibleWithOutcome: 4, returnsPct: {count: 4, mean: 2, median: 1, stdev: 3}, positiveShare: 0.5}]}],
  };
  await mockApis(page, {'goldmine:backtest': {status: 200, json: goldmineBacktest({totalSignals: 12, replay: {currentVersionSignals: 12, matched: 12, mismatched: [], unsupportedCount: 0, unsupportedModelVersions: []}, performance, calibration})}});
  await openDashboard(page);
  await tab(page, 'Goldmine').click();
  await expect(page.getByRole('heading', {name: 'Backtesting & calibration'})).toBeVisible();
  await expect(page.getByText('12 signals recorded.')).toBeVisible();
  await expect(page.getByText('BREAKOUT')).toBeVisible();
  await expect(page.getByText('Score threshold sweep (descriptive only)')).toBeVisible();
  await expect(page.getByText('Too few evaluation signals for a performance conclusion', {exact: false})).toBeVisible();
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
    outcomes: [{horizon: '15m', status: 'observed', returnPct: 4.2}, {horizon: '1h', status: 'pending', returnPct: null}],
  };
  await mockApis(page, {goldmine: {status: 200, json: goldmineTracking({signals: [signal]})}});
  await openDashboard(page);
  await tab(page, 'Goldmine').click();
  await expect(page.getByRole('heading', {name: 'Recent opportunities'})).toBeVisible();
  await expect(page.getByText('15m: +4.2%')).toBeVisible();
  await expect(page.getByText('1h: pending')).toBeVisible();
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
}
