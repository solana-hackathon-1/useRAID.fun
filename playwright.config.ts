import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  timeout: 60000,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: 'http://localhost:3000', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  webServer: [
    {
      command: 'DEMO_MODE=true npm run dev -- --port 3000',
      url: 'http://localhost:3000',
      reuseExistingServer: !process.env.CI,
      timeout: 180000,
    },
    {
      command:
        'DEMO_MODE=false METEORA_LAUNCH_ENABLED=true NEXT_DIST_DIR=.next-db-down DATABASE_URL=postgresql://useraid:useraid@127.0.0.1:1/useraid_down npm run dev -- --port 3008',
      url: 'http://localhost:3008/privacy',
      reuseExistingServer: !process.env.CI,
      timeout: 180000,
    },
  ],
});
