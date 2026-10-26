import { defineConfig, devices } from '@playwright/test';
import { assertTestDatabase } from './tests/helpers/db-guard';
import { notificationsBrowserEnvironment } from './tests/helpers/notifications-fixture';
assertTestDatabase();
const baseURL = process.env.NOTIFICATIONS_BROWSER_URL || 'http://127.0.0.1:3042';
const previewUrl = new URL(baseURL);
if (
  !['127.0.0.1', 'localhost'].includes(previewUrl.hostname) ||
  previewUrl.protocol !== 'http:' ||
  !previewUrl.port
)
  throw Error('Owned loopback preview required');
const production = process.env.NOTIFICATIONS_SERVER_MODE === 'production';
export default defineConfig({
  testDir: './tests/browser-notifications',
  testMatch: 'notifications.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90000,
  outputDir: production
    ? 'test-results/notifications-production'
    : 'test-results/notifications-development',
  use: {
    baseURL,
    trace: 'off',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath: process.env.NOTIFICATIONS_CHROMIUM_EXECUTABLE_PATH },
  },
  webServer:
    process.env.NOTIFICATIONS_EXTERNAL_PREVIEW === 'true'
      ? undefined
      : {
          command: production
            ? `node_modules/.bin/next start --hostname 127.0.0.1 --port ${previewUrl.port}`
            : `node_modules/.bin/next dev --webpack --hostname 127.0.0.1 --port ${previewUrl.port}`,
          cwd: process.env.NOTIFICATIONS_PREVIEW_SOURCE,
          url: baseURL + '/notifications',
          reuseExistingServer: false,
          timeout: 120000,
          gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
          env: {
            NODE_ENV: production ? 'production' : 'development',
            APP_URL: baseURL,
            NEXT_PUBLIC_APP_URL: baseURL,
            ...notificationsBrowserEnvironment(),
          },
        },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
});
