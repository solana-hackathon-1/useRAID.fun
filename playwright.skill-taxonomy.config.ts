import { defineConfig } from '@playwright/test';
import { assertTestDatabase } from './tests/helpers/db-guard';
assertTestDatabase();
const baseURL = process.env.SKILL_TAXONOMY_TEST_URL || 'http://127.0.0.1:3022';
const url = new URL(baseURL);
if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.port)
  throw Error('Owned loopback API preview required');
export default defineConfig({
  testDir: './tests/browser-skill-taxonomy',
  testMatch: 'skill-taxonomy.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  outputDir: './test-results/skill-taxonomy',
  use: { baseURL, trace: 'retain-on-failure' },
  webServer: {
    command: `node_modules/.bin/next dev --webpack --hostname 127.0.0.1 --port ${url.port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      NODE_ENV: 'development',
      DEMO_MODE: 'false',
      APP_URL: baseURL,
      NEXT_PUBLIC_APP_URL: baseURL,
      USDC_NETWORK: 'devnet',
      X_ADMIN_USER_ID: 'synthetic-taxonomy-publisher',
      ADMIN_X_IDS: '',
      SKILL_TAXONOMY_PUBLICATION_ENABLED: 'true',
      ACCOUNT_FOLDS_ENABLED: 'false',
      WALLET_LINKS_ENABLED: 'false',
      LIVE_COLLECTION_APPROVED: 'false',
      X_TRACKING_V2_SETTLEMENT_ENABLED: 'false',
      LAUNCH_ENABLED: 'false',
      PAYOUT_ENABLED: 'false',
    },
  },
});
