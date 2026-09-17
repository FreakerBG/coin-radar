// The first dev-server visit triggers Vite dependency optimization and full reloads.
// Load the page once before the smoke tests so assertions do not race those reloads.
import {chromium} from '@playwright/test';

export default async function warmUp(config) {
  const {baseURL} = config.projects[0].use;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.context().route(url => !['localhost', '127.0.0.1'].includes(url.hostname), route => route.abort());
    await page.route('**/api/**', route => route.fulfill({status: 503, json: {coins: [], asOf: null, items: [], posts: [], error: 'Warm-up.'}}));
    await page.goto(baseURL, {timeout: 120000});
    await page.getByRole('tab', {name: 'Discover'}).waitFor({timeout: 120000});
    await page.waitForLoadState('networkidle', {timeout: 60000});
  } finally {
    await browser.close();
  }
}
