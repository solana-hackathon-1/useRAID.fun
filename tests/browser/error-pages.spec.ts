import { test, expect } from '@playwright/test';
test.use({ baseURL: 'http://localhost:3008' });
test('a database outage shows the error fallback inside the layout', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Activity is unavailable' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.locator('header').first()).toBeAttached();
  if (testInfo.project.name === 'mobile')
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
});
test('the health endpoint reports the outage as unavailable', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.status()).toBe(503);
});
