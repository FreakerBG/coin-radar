// Browser smoke tests against the local dev server (mock Sites sign-in, local Miniflare).
// Every /api request is fulfilled in the browser from fixtures, so no provider is contacted.
import {tmpdir} from 'node:os';
import path from 'node:path';
import {defineConfig, devices} from '@playwright/test';

const port = 5173;

export default defineConfig({
  testDir: 'e2e',
  // Keep traces outside the project: writes under the watched root can restart the dev server.
  outputDir: path.join(tmpdir(), 'coin-radar-playwright'),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 60000,
  expect: {timeout: 15000},
  globalSetup: './e2e/warm-up.mjs',
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'npm run dev',
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 180000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
