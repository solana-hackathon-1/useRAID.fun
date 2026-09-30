import { defineConfig, devices } from '@playwright/test';

if (new URL(process.env.DATABASE_URL || 'http://invalid').pathname !== '/useraid_test')
  throw Error('Live browser fixtures require dedicated useraid_test database.');

export default defineConfig({
  testDir: './tests/browser-live',
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://localhost:3006', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  webServer: {
    command:
      'DEMO_MODE=false X_TRACKING_V2_ENABLED=true NEXT_PUBLIC_APP_URL=http://localhost:3006 LIVE_COLLECTION_APPROVED=true LAUNCH_ENABLED=true PAYOUT_ENABLED=true OPERATOR_PUBLIC_KEY=11111111111111111111111111111111 PLATFORM_TREASURY_ADDRESS=SysvarRent111111111111111111111111111111111 X_BEARER_TOKEN=fixture SOLANA_RPC_URL=https://example.invalid PINATA_JWT=fixture LAUNCH_KEY_1=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= npm run start -- --port 3006',
    url: 'http://localhost:3006',
    reuseExistingServer: false,
  },
});
