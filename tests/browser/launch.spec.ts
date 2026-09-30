import { test, expect } from '@playwright/test';
test('launchpad entry is marked coming soon', async ({ page }) => {
  await page.goto('/launch');
  await expect(page.getByRole('heading', { name: 'Launchpads' })).toBeVisible();
  await expect(page.getByText('Token creation, creator-fee collection')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
});
