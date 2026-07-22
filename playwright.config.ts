import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  outputDir: '.playwright/results',
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: '.playwright/report', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on',
    screenshot: 'on',
    video: 'on',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'npm run e2e:serve',
    url: 'http://127.0.0.1:4173/client/login',
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
