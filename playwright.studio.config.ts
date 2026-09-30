import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser-studio',
  workers: 1,
  fullyParallel: false,
  use: { baseURL: 'http://localhost:3007', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  webServer: {
    command: 'npm run studio:preview',
    url: 'http://localhost:3007/studio-test',
    reuseExistingServer: true,
    timeout: 60000,
  },
});
