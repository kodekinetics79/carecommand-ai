import { defineConfig, devices } from '@playwright/test';

const useInstalledChrome = process.env.E2E_USE_INSTALLED_CHROME === 'true';
const headedInstalledChrome = process.env.E2E_HEADLESS !== 'true';

const projects = useInstalledChrome
  ? [
      {
        name: 'desktop-installed-chrome',
        use: {
          ...devices['Desktop Chrome'],
          channel: 'chrome' as const,
          headless: !headedInstalledChrome,
        },
      },
      {
        name: 'mobile-installed-chrome',
        use: {
          ...devices['Pixel 7'],
          channel: 'chrome' as const,
          headless: !headedInstalledChrome,
        },
      },
    ]
  : [
      { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
      { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
    ];

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  outputDir: '.playwright/results',
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: '.playwright/report', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:44173',
    trace: 'on',
    screenshot: 'on',
    video: 'on',
  },
  projects,
  webServer: {
    command: 'npm run e2e:serve',
    url: 'http://127.0.0.1:44173/client/login',
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
