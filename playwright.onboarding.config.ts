import { defineConfig, devices } from '@playwright/test';
import { assertTestDatabase } from './tests/helpers/db-guard';
assertTestDatabase();
const baseURL = process.env.RAID_ONBOARDING_PREVIEW_URL || 'http://localhost:3014';
const parsed = new URL(baseURL);
if (!['localhost', '127.0.0.1'].includes(parsed.hostname))
  throw Error('Owned loopback preview required');
export default defineConfig({
  testDir: './tests/browser-onboarding',
  testMatch: 'raider-onboarding.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  outputDir: './test-results/onboarding',
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
      NEXT_PUBLIC_APP_URL: baseURL,
      APP_URL: baseURL,
      USDC_NETWORK: 'devnet',
      RAIDER_ONBOARDING_ENABLED: 'true',
      RAIDER_ONBOARDING_CATALOG:
        '[{"id":"qa","label":"Quality assurance"},{"id":"frontend","label":"Frontend"}]',
      ACCOUNT_FOLDS_ENABLED: 'false',
      WALLET_LINKS_ENABLED: 'false',
      LIVE_COLLECTION_APPROVED: 'false',
      X_TRACKING_V2_SETTLEMENT_ENABLED: 'false',
      LAUNCH_ENABLED: 'false',
      PAYOUT_ENABLED: 'false',
    },
  },
});
