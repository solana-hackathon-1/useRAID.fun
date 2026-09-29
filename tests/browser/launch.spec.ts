import { test, expect } from '@playwright/test';
test('pump.fun launch entry is visible and preview stays read-only', async ({ page }) => {
  await page.goto('/launch');
  await expect(page.getByRole('heading', { name: 'Launch a token' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Launch unavailable' })).toBeVisible();
  await expect(page.getByText('Launch opens when chain connection')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
});
