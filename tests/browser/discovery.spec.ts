import { test, expect } from '@playwright/test';
test('search and ranking tabs expose the matching campaigns', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Make your community heard.' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Search campaigns' }).fill('POPCAT');
  await expect(page.locator('.raid-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.raid-table tbody')).toContainText('POPCAT');
  await page.getByRole('textbox', { name: 'Search campaigns' }).fill('no-such-token');
  await expect(page.getByText('No matching campaigns')).toBeVisible();
  await page.getByRole('textbox', { name: 'Search campaigns' }).fill('');
  await page.getByRole('tab', { name: 'Rising' }).click();
  await expect(page.getByRole('tab', { name: 'Rising' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.raid-table tbody tr')).toHaveCount(7);
  await page.getByRole('tab', { name: 'New raids' }).click();
  await expect(page.locator('.raid-table tbody tr').first()).toContainText('BONK');
});
test('raid detail leads to the exact token and preview actions are disabled', async ({ page }) => {
  await page.goto('/raids/demo-bonk');
  await expect(
    page.getByRole('heading', { name: 'The pack is building. Let’s show up.' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Raid on X', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Trade', exact: true })).toBeDisabled();
  await page.getByRole('link', { name: 'View token profile' }).click();
  await expect(page.getByRole('heading', { name: 'Community attention' })).toBeVisible();
  await expect(page.getByText('Token identity', { exact: true })).toBeVisible();
});
test('preview mutations and admin access remain blocked', async ({ page, request }) => {
  await page.goto('/creator');
  await expect(
    page.getByRole('heading', { name: 'Bring your community to a post.' }),
  ).toBeVisible();
  await page.goto('/admin');
  await expect(
    page.getByText('Admin controls are disabled in the read-only preview.'),
  ).toBeVisible();
  const response = await request.post('/api/raids', {
    headers: { origin: 'http://localhost:3000' },
    data: {},
  });
  expect(response.status()).toBe(403);
});
test('page has no document overflow and no runtime errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('heading', { name: 'Make your community heard.' }).waitFor();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(errors).toEqual([]);
});
