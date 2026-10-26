import { defineConfig, devices } from '@playwright/test';
import { assertTestDatabase } from './tests/helpers/db-guard';
import { workCreationBrowserEnvironment } from './tests/helpers/work-creation-fixture';
assertTestDatabase();
const baseURL = process.env.WORK_CREATION_BROWSER_URL || 'http://127.0.0.1:3041';
const previewUrl = new URL(baseURL);
if (
  !['127.0.0.1', 'localhost'].includes(previewUrl.hostname) ||
  previewUrl.protocol !== 'http:' ||
  !previewUrl.port
)
  throw Error('Owned loopback preview required');
const production = process.env.WORK_CREATION_SERVER_MODE === 'production';
export default defineConfig({
  testDir: './tests/browser-work-creation',
  testMatch: 'work-creation.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90000,
  outputDir: production
    ? 'test-results/work-creation-production'
    : 'test-results/work-creation-development',
  use: {
    baseURL,
    trace: 'off',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath: process.env.WORK_CREATION_CHROMIUM_EXECUTABLE_PATH },
  },
  webServer:
    process.env.WORK_CREATION_EXTERNAL_PREVIEW === 'true'
      ? undefined
      : {
          command: production
            ? `node_modules/.bin/next start --hostname 127.0.0.1 --port ${previewUrl.port}`
            : `node_modules/.bin/next dev --webpack --hostname 127.0.0.1 --port ${previewUrl.port}`,
          cwd: process.env.WORK_CREATION_PREVIEW_SOURCE,
          url: baseURL + '/creator/work/new',
          reuseExistingServer: false,
          timeout: 120000,
          gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
          env: {
            NODE_ENV: production ? 'production' : 'development',
            APP_URL: baseURL,
            NEXT_PUBLIC_APP_URL: baseURL,
            ...workCreationBrowserEnvironment(),
          },
        },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
});
