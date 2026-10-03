import { test, expect } from '@playwright/test';
import { watchConsole } from '../helpers/browser-console';
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
  await expect(page.getByRole('button', { name: /Trad/ })).toHaveCount(0);
  await page.getByRole('link', { name: 'View token profile' }).click();
  await expect(page.getByRole('heading', { name: 'Community attention' })).toBeVisible();
  await expect(page.getByText('Token identity', { exact: true })).toBeVisible();
  await expect(page.locator('.detail-header').getByRole('button')).toHaveCount(0);
  await expect(
    page.locator('.detail-header').getByRole('link', { name: 'Join live raid' }),
  ).toBeVisible();
});
test('token page header links to the live raid', async ({ page }) => {
  await page.goto('/raids/demo-bonk');
  await page.getByRole('link', { name: 'View token profile' }).click();
  await page.locator('.detail-header').getByRole('link', { name: 'Join live raid' }).click();
  await expect(page).toHaveURL(/\/raids\/demo-bonk$/);
});
test('Live tab shows the campaigns that posted in the last hour', async ({ page }) => {
  await page.goto('/');
  const total = await page.locator('.raid-table tbody tr').count();
  await page.getByRole('tab', { name: 'Live' }).click();
  await expect(page.getByRole('tab', { name: 'Live' })).toHaveAttribute('aria-selected', 'true');
  // Every demo campaign has a post from 15 minutes ago, so all of them are live.
  await expect(page.locator('.raid-table tbody tr')).toHaveCount(total);
  await expect(page.getByRole('status').filter({ hasText: 'Showing' })).toHaveText(
    `Showing ${total} campaigns`,
  );
  await page.getByRole('textbox', { name: 'Search campaigns' }).fill('no-such-token');
  await expect(page.getByText('No matching campaigns')).toBeVisible();
});
test('mobile menu closes after navigating', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile navigation only');
  await page.goto('/');
  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.locator('#mobile-navigation')).toBeVisible();
  await page.locator('#mobile-navigation').getByRole('link', { name: 'How it works' }).click();
  await expect(page).toHaveURL(/\/methodology$/);
  await expect(page.locator('#mobile-navigation')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Open menu' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
});
test('unknown pages render the not-found view', async ({ page }) => {
  const response = await page.goto('/no-such-page');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'This signal couldn’t be found.' })).toBeVisible();
});
test.describe('locale and time zone independence', () => {
  test.use({ locale: 'de-DE', timezoneId: 'Asia/Kathmandu' });
  for (const path of ['/', '/raids/demo-bonk']) {
    test(`${path} hydrates without warnings`, async ({ page }) => {
      const problems = watchConsole(page);
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('h1').first()).toBeVisible();
      expect(problems.filter((p) => /hydrat|did not match/i.test(p))).toEqual([]);
      expect(problems).toEqual([]);
    });
  }
  test('token page hydrates without warnings', async ({ page }) => {
    const problems = watchConsole(page);
    await page.goto('/raids/demo-bonk');
    await page.getByRole('link', { name: 'View token profile' }).click();
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Community attention' })).toBeVisible();
    expect(problems).toEqual([]);
  });
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
