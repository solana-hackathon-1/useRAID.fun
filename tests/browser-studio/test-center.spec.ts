import { test, expect } from '@playwright/test';
import { watchConsole } from '../helpers/browser-console';

test.use({ actionTimeout: 5000 });

test('test center distinguishes browser checks from backend-only implementation', async ({
  page,
}) => {
  await page.goto('/test-center');
  await expect(page.getByRole('heading', { name: 'Implementation test center' })).toBeVisible({
    timeout: 5000,
  });
  await expect(
    page.getByText('T006 · Canonical identity & wallet links', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Review and integration pending', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: /link additional wallet|revoke wallet/i }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Backend checks', exact: true }).click();
  await expect(page.getByText('T019 · Command receipts', { exact: true })).toBeVisible();
  await expect(page.getByText('Legacy Creator Studio', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Browser checks', exact: true }).click();
  await expect(page.getByText('Legacy Creator Studio', { exact: true })).toBeVisible();
  await expect(page.getByText('T019 · Command receipts', { exact: true })).toHaveCount(0);
});

test('amount explorer uses exact arithmetic and recovers from rejected precision', async ({
  page,
}) => {
  const problems = watchConsole(page);
  await page.goto('/test-center');
  const explorer = page.getByRole('region', { name: 'Exact amount explorer' });
  await explorer.getByLabel('Display amount').fill('250.50');
  await explorer.getByLabel('Asset decimals').selectOption('6');
  await explorer.getByRole('button', { name: 'Calculate exact amounts' }).click();
  await expect(explorer.getByTestId('base-units')).toHaveText('250500000');
  await explorer.getByLabel('Display amount').fill('0.0000001');
  await explorer.getByRole('button', { name: 'Calculate exact amounts' }).click();
  await expect(explorer.getByRole('alert')).toContainText('EXCESS_PRECISION');
  await expect(explorer.getByTestId('base-units')).toHaveCount(0);
  await explorer.getByLabel('Display amount').fill('0.000001');
  await explorer.getByLabel('Split weights').fill('1, 1, 1');
  await explorer.getByRole('button', { name: 'Calculate exact amounts' }).click();
  await expect(explorer.getByTestId('base-units')).toHaveText('1');
  await expect(explorer.getByTestId('split-units')).toHaveText('1, 0, 0');
  await explorer.getByLabel('Display amount').fill('18446744073709551616');
  await explorer.getByLabel('Asset decimals').selectOption('0');
  await explorer.getByRole('button', { name: 'Calculate exact amounts' }).click();
  await expect(explorer.getByRole('alert')).toContainText('AMOUNT_OVERFLOW');
  expect(problems).toEqual([]);
});

test('capacity explorer preserves review duty and distinguishes closure from payment', async ({
  page,
}) => {
  await page.goto('/test-center');
  const explorer = page.getByRole('region', { name: 'Capacity state explorer' });
  await explorer.getByLabel('Engagement state').selectOption('UNDER_REVIEW');
  await expect(explorer.getByRole('status')).toContainText('Active slot held');
  await explorer.getByLabel('Engagement state').selectOption('ACCEPTED');
  await expect(explorer.getByRole('status')).toContainText('Active slot released');
  await expect(explorer.getByText('Payment may still be pending.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('test center starts the existing isolated Studio flow', async ({ page }) => {
  await page.goto('/test-center');
  await page.getByRole('button', { name: 'Enter test Creator Studio' }).click();
  await expect(page.getByRole('heading', { name: 'Creator Studio', exact: true })).toBeVisible();
  await page.goto('/creator/balance');
  await expect(page.getByRole('button', { name: 'Add test USDC' })).toBeVisible();
  await page.goto('/test-center');
  await page.getByRole('link', { name: 'Open account' }).click();
  await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
});
