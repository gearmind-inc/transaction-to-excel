import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

// Keep the downloaded testing browser inside this repository, not a user profile.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('node_modules/.cache/ms-playwright');

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  outputDir: 'test-results/browser',
  webServer: {
    command: 'node scripts/fixture-server.mjs',
    url: 'http://127.0.0.1:4173/transactions',
    reuseExistingServer: !process.env.CI,
  },
});
