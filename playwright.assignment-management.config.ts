import { defineConfig, devices } from '@playwright/test';
import { assertTestDatabase } from './tests/helpers/db-guard';
assertTestDatabase();
const baseURL = process.env.ASSIGNMENT_MANAGEMENT_BROWSER_URL || 'http://127.0.0.1:3036';
const previewUrl = new URL(baseURL);
if (
  !['127.0.0.1', 'localhost'].includes(previewUrl.hostname) ||
  previewUrl.protocol !== 'http:' ||
  !previewUrl.port
)
  throw Error('Owned loopback preview required');
const production = process.env.ASSIGNMENT_MANAGEMENT_SERVER_MODE === 'production';
export default defineConfig({
  testDir: './tests/browser-practice-assignment-management',
  testMatch:
    process.env.ASSIGNMENT_MANAGEMENT_TEST_WRITES === 'false'
      ? 'writeoff.spec.ts'
      : 'assignment-management.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60000,
  outputDir: production
    ? 'planning/task-evidence/T013-assignment-management/browser-production'
    : 'planning/task-evidence/T013-assignment-management/browser-development',
  use: {
    baseURL,
    trace: 'off',
    launchOptions: { executablePath: process.env.ASSIGNMENT_MANAGEMENT_CHROMIUM_EXECUTABLE_PATH },
  },
  webServer:
    process.env.ASSIGNMENT_MANAGEMENT_EXTERNAL_PREVIEW === 'true'
      ? undefined
      : {
          command: production
            ? `node_modules/.bin/next start --hostname 127.0.0.1 --port ${previewUrl.port}`
            : `node_modules/.bin/next dev --webpack --hostname 127.0.0.1 --port ${previewUrl.port}`,
          cwd: process.env.ASSIGNMENT_MANAGEMENT_PREVIEW_SOURCE,
          url: baseURL + '/methodology',
          reuseExistingServer: false,
          timeout: 120000,
          gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
          env: {
            NODE_ENV: production ? 'production' : 'development',
            DEMO_MODE: 'false',
            ADMIN_X_IDS: 'synthetic-management-admin-x',
            X_ADMIN_USER_ID: '',
            APP_URL: baseURL,
            NEXT_PUBLIC_APP_URL: baseURL,
            USDC_NETWORK: 'devnet',
            PRACTICE_TRIAL_CATALOG_ID: 'synthetic-submission-catalog',
            PRACTICE_REVIEW_READS_ENABLED: 'false',
            PRACTICE_REVIEW_ASSIGNMENTS_ENABLED:
              process.env.ASSIGNMENT_MANAGEMENT_TEST_WRITES === 'false' ? 'false' : 'true',
            PRACTICE_TRIAL_ATTEMPTS_ENABLED: 'false',
            PRACTICE_TRIAL_SUBMISSIONS_ENABLED: 'false',
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
