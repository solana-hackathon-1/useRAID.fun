import { test, expect } from '@playwright/test';
import { demoRaids } from '../../src/lib/demo';
import { expectCleanPage } from '../helpers/page-checks';
const mint = demoRaids()[0].mint!;
const pages: [string, string][] = [
  ['/', 'Make your community heard.'],
  ['/methodology', ''],
  ['/privacy', ''],
  ['/launch', 'Launchpads'],
  ['/raids/demo-bonk', ''],
  [`/tokens/${mint}`, ''],
];
for (const [path, heading] of pages)
  test(`${path.replace(mint, '[mint]')} loads cleanly`, async ({ page }, testInfo) => {
    await expectCleanPage(page, path, testInfo);
    if (heading) await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  });
test('the launch page says Coming soon', async ({ page }) => {
  await page.goto('/launch');
  await expect(page.locator('main').getByText('Coming soon').first()).toBeVisible();
});
test('the 404 page loads cleanly', async ({ page }, testInfo) => {
  await expectCleanPage(page, '/no-such-page', testInfo, { status: 404 });
  await expect(page.getByRole('heading', { name: 'This signal couldn’t be found.' })).toBeVisible();
});
