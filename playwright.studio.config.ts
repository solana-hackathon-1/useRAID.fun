import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser-studio',
  timeout: 60000,
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: 'http://localhost:3007', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  webServer: {
    command: 'npm run studio:preview',
    url: 'http://localhost:3007/studio-test',
    reuseExistingServer: true,
    timeout: 180000,
  },
});
