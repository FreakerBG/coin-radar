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

async function mockApis(page, overrides = {}) {
  const responses = {
    market: {status: 200, json: market},
    news: {status: 200, json: {items: [], asOf: '2026-01-01T00:00:00.000Z'}},
    social: {status: 200, json: {status: 'not_connected', posts: [], message: 'X is not connected.', configured: false, usedToday: 0, dailyLimit: 0}},
    portfolio: {status: 401, json: {error: 'Sign in to load your research account.'}},
    advisor: {status: 401, json: {error: 'Sign in required.'}},
    monitor: {status: 401, json: {error: 'Sign in required.'}},
    ...overrides,
  };
  await page.context().route(url => !['localhost', '127.0.0.1'].includes(url.hostname), route => route.abort());
  await page.route('**/api/**', route => {
    const name = new URL(route.request().url()).pathname.split('/')[2];
    const response = responses[name];
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

test('switches between Discover, Watchlist, Advisor and Alerts', async ({page}) => {
  await mockApis(page);
  await openDashboard(page);
  await tab(page, 'Watchlist').click();
  await expect(page.getByRole('heading', {name: 'Your watchlist', exact: true})).toBeVisible();
  await tab(page, 'Advisor').click();
  await expect(page.getByRole('heading', {name: 'Advisor & position control'})).toBeVisible();
  await tab(page, 'Alerts').click();
  await expect(page.getByRole('heading', {name: 'Watchlist alerts'})).toBeVisible();
  await tab(page, 'Discover').click();
  await expect(page.getByRole('heading', {name: 'Market radar'})).toBeVisible();
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

for (const width of [320, 360, 390]) {
  test(`narrow mobile viewport (${width}px) has no horizontal page overflow`, async ({page}) => {
    await page.setViewportSize({width, height: 800});
    await mockApis(page);
    // Measure with the market table rendered; the wide table must scroll inside its own container.
    await openDashboard(page);
    for (const name of ['Discover', 'Watchlist', 'Advisor', 'Alerts']) {
      await tab(page, name).click();
      await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${name} tab overflows horizontally by ${overflow}px`).toBeLessThanOrEqual(0);
    }
  });
}
