import { test, expect } from '@playwright/test';
import { watchConsole } from '../helpers/browser-console';
test('pages load under the Content-Security-Policy without console or policy errors', async ({
  page,
}) => {
  const problems = watchConsole(page);
  const home = await page.goto('/');
  const csp = home!.headers()['content-security-policy'];
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain('https://pbs.twimg.com');
  await expect(page.getByRole('heading', { name: 'Make your community heard.' })).toBeVisible();
  for (const path of ['/creator', '/raids/demo-bonk', '/methodology', '/privacy']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
  }
  expect(problems).toEqual([]);
});
test('the discovery feed is cacheable for a few seconds and rejects framing', async ({
  request,
}) => {
  const response = await request.get('/api/discovery');
  expect(response.ok()).toBe(true);
  expect(response.headers()['cache-control']).toBe('public, max-age=10');
  expect(response.headers()['x-frame-options']).toBe('DENY');
});
