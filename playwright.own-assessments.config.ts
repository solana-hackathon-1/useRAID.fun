import { defineConfig, devices } from '@playwright/test';
import { assertTestDatabase } from './tests/helpers/db-guard';
assertTestDatabase();
const baseURL = process.env.OWN_ASSESSMENT_BROWSER_URL || 'http://127.0.0.1:3025';
const previewUrl = new URL(baseURL);
if (
  !['127.0.0.1', 'localhost'].includes(previewUrl.hostname) ||
  previewUrl.protocol !== 'http:' ||
  !previewUrl.port
)
  throw Error('Owned loopback preview required');
export default defineConfig({
  testDir: './tests/browser-own-assessments',
  testMatch: 'own-assessments.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 45000,
  outputDir:
    process.env.OWN_ASSESSMENT_SERVER_MODE === 'production'
      ? 'test-results/own-assessments-production'
      : 'test-results/own-assessments-development',
  use: {
    baseURL,
    trace: 'off',
    launchOptions: { executablePath: process.env.OWN_ASSESSMENT_CHROMIUM_EXECUTABLE_PATH },
  },
  webServer:
    process.env.OWN_ASSESSMENT_EXTERNAL_PREVIEW === 'true'
      ? undefined
      : {
          command:
            process.env.OWN_ASSESSMENT_SERVER_MODE === 'production'
              ? `node_modules/.bin/next start --hostname 127.0.0.1 --port ${previewUrl.port}`
              : `node_modules/.bin/next dev --webpack --hostname 127.0.0.1 --port ${previewUrl.port}`,
          cwd: process.env.OWN_ASSESSMENT_PREVIEW_SOURCE,
          url: baseURL + '/raider/skills/frontend',
          reuseExistingServer: false,
          timeout: 60000,
          gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
          env: {
            NODE_ENV:
              process.env.OWN_ASSESSMENT_SERVER_MODE === 'production'
                ? 'production'
                : 'development',
            DEMO_MODE: 'false',
            APP_URL: baseURL,
            NEXT_PUBLIC_APP_URL: baseURL,
            USDC_NETWORK: 'devnet',
            SKILL_TAXONOMY_ID: 'synthetic-submission-catalog',
            PRACTICE_ASSESSMENT_CATALOG_ID: 'synthetic-submission-catalog',
            SKILL_ASSESSMENT_READS_ENABLED: 'true',
            SKILL_CLAIMS_ENABLED: 'false',
            RAIDER_ONBOARDING_ENABLED: 'false',
            PRACTICE_TRIAL_ATTEMPTS_ENABLED: 'false',
            PRACTICE_TRIAL_SUBMISSIONS_ENABLED: 'false',
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
