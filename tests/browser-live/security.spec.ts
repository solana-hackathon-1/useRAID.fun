import { test, expect } from '@playwright/test';
import { db } from '../../src/lib/db';
import { assertTestDatabase, truncateAll } from '../helpers/db-guard';
import { watchConsole } from '../helpers/browser-console';
let raidId: string;
test.beforeAll(async () => {
  assertTestDatabase();
  await truncateAll(db);
  const creator = await db.user.create({
    data: { xId: 'security-creator', handle: 'security', approved: true },
  });
  raidId = (
    await db.raid.create({
      data: {
        creatorId: creator.id,
        tag: 'raid_security',
        title: 'Security Raid',
        description: 'Headers and console check.',
        startsAt: new Date(Date.now() - 3600000),
        endsAt: new Date(Date.now() + 3600000),
        status: 'ACTIVE',
      },
    })
  ).id;
});
test.afterAll(async () => {
  await truncateAll(db);
  await db.$disconnect();
});
test('production headers and a clean console on live pages', async ({ page }) => {
  const problems = watchConsole(page);
  const home = await page.goto('/');
  const headers = home!.headers();
  expect(headers['content-security-policy']).toContain("object-src 'none'");
  expect(headers['content-security-policy']).not.toContain("'unsafe-eval'");
  expect(headers['strict-transport-security']).toBe('max-age=63072000; includeSubDomains');
  await page.waitForLoadState('networkidle');
  await page.goto(`/raids/${raidId}`);
  await page.waitForLoadState('networkidle');
  await page.goto('/creator');
  await page.waitForLoadState('networkidle');
  await page.goto('/admin?auth=state');
  await expect(page.getByText('Authorization expired or was invalid.')).toBeVisible();
  expect(problems).toEqual([]);
});
test('OAuth start ignores prefetches and media is served immutably', async ({ request }) => {
  const prefetch = await request.get('/api/auth/x', {
    headers: { 'next-router-prefetch': '1' },
    maxRedirects: 0,
  });
  expect(prefetch.status()).toBe(204);
  expect(prefetch.headers()['set-cookie']).toBeUndefined();
  const missing = await request.get(`/api/media/${'x'.repeat(25)}`);
  expect(missing.status()).toBe(404);
});
