import { test, expect } from '@playwright/test';
import { expectCleanPage } from '../helpers/page-checks';

// The signed-out launch wizard needs neither a database nor Solana configuration to render. This server
// runs with METEORA_LAUNCH_ENABLED=true (see playwright.config.ts) and none of the other Meteora settings,
// so the wizard must list what is missing instead of offering a launch.
test.use({ baseURL: 'http://localhost:3008' });
test('the Meteora launch wizard renders offline and lists missing configuration', async ({
  page,
}, testInfo) => {
  await expectCleanPage(page, '/launch', testInfo);
  await expect(page.getByRole('heading', { name: 'Launch. Trade. Raid.' })).toBeVisible();
  await expect(page.getByText('Solana RPC needs configuration.')).toBeVisible();
  await expect(page.getByText('Launch image verification needs configuration.')).toBeVisible();
});
