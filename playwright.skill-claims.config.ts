import { defineConfig, devices } from '@playwright/test';
import { assertTestDatabase } from './tests/helpers/db-guard';
assertTestDatabase();
const baseURL = process.env.SKILL_FORM_BROWSER_URL || 'http://127.0.0.1:3021',
  parsed = new URL(baseURL);
if (!['localhost', '127.0.0.1'].includes(parsed.hostname))
  throw Error('Owned loopback preview required');
export default defineConfig({
  testDir: './tests/browser-skill-claims',
  testMatch: 'skill-claims.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  outputDir: './test-results/skill-claims',
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  webServer: {
    command: `node_modules/.bin/next dev --webpack --hostname 127.0.0.1 --port ${parsed.port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      NODE_ENV: 'development',
      DEMO_MODE: 'false',
      APP_URL: baseURL,
      NEXT_PUBLIC_APP_URL: baseURL,
      USDC_NETWORK: 'devnet',
      SKILL_CLAIMS_ENABLED: 'true',
      SKILL_TAXONOMY_ID: 'synthetic-browser-catalog',
      RAIDER_ONBOARDING_ENABLED: 'true',
      ACCOUNT_FOLDS_ENABLED: 'false',
      WALLET_LINKS_ENABLED: 'false',
      LIVE_COLLECTION_APPROVED: 'false',
      X_TRACKING_V2_SETTLEMENT_ENABLED: 'false',
      LAUNCH_ENABLED: 'false',
      PAYOUT_ENABLED: 'false',
    },
  },
});
