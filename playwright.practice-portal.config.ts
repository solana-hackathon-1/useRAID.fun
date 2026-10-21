import { defineConfig, devices } from '@playwright/test';
import { assertTestDatabase } from './tests/helpers/db-guard';
assertTestDatabase();
const baseURL = process.env.PRACTICE_PORTAL_BROWSER_URL || 'http://127.0.0.1:3026';
const previewUrl = new URL(baseURL);
if (
  !['127.0.0.1', 'localhost'].includes(previewUrl.hostname) ||
  previewUrl.protocol !== 'http:' ||
  !previewUrl.port
)
  throw Error('Owned loopback preview required');
const production = process.env.PRACTICE_PORTAL_SERVER_MODE === 'production';
export default defineConfig({
  testDir: './tests/browser-practice-portal',
  testMatch: 'practice-portal.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60000,
  outputDir: production
    ? 'test-results/practice-portal-production'
    : 'test-results/practice-portal-development',
  use: {
    baseURL,
    trace: 'off',
    launchOptions: { executablePath: process.env.PRACTICE_PORTAL_CHROMIUM_EXECUTABLE_PATH },
  },
  webServer:
    process.env.PRACTICE_PORTAL_EXTERNAL_PREVIEW === 'true'
      ? undefined
      : {
          command: production
            ? `node_modules/.bin/next start --hostname 127.0.0.1 --port ${previewUrl.port}`
            : `node_modules/.bin/next dev --webpack --hostname 127.0.0.1 --port ${previewUrl.port}`,
          cwd: process.env.PRACTICE_PORTAL_PREVIEW_SOURCE,
          url: baseURL + '/raider/practice',
          reuseExistingServer: false,
          timeout: 120000,
          gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
          env: {
            NODE_ENV: production ? 'production' : 'development',
            DEMO_MODE: 'false',
            ADMIN_X_IDS: '',
            X_ADMIN_USER_ID: '',
            APP_URL: baseURL,
            NEXT_PUBLIC_APP_URL: baseURL,
            USDC_NETWORK: 'devnet',
            PRACTICE_TRIAL_CATALOG_ID: 'synthetic-submission-catalog',
            PRACTICE_PORTAL_READS_ENABLED: 'true',
            PRACTICE_TRIAL_ATTEMPTS_ENABLED: 'true',
            PRACTICE_TRIAL_SUBMISSIONS_ENABLED: 'true',
            SKILL_ASSESSMENT_READS_ENABLED: 'false',
            SKILL_CLAIMS_ENABLED: 'false',
            RAIDER_ONBOARDING_ENABLED: 'false',
            PRACTICE_TRIAL_ASSESSMENTS_ENABLED: 'false',
            PRACTICE_ASSESSMENT_DECISIONS_ENABLED: 'false',
            ACCOUNT_FOLDS_ENABLED: 'false',
            WALLET_LINKS_ENABLED: 'false',
            LIVE_COLLECTION_APPROVED: 'false',
            LAUNCH_ENABLED: 'false',
            PAYOUT_ENABLED: 'false',
            X_TRACKING_V2_SETTLEMENT_ENABLED: 'false',
          },
        },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
});
