import { test, expect } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { db } from '../../src/lib/db';
import { assertTestDatabase, truncateAll } from '../helpers/db-guard';
import { watchConsole } from '../helpers/browser-console';
const names = Array.from({ length: 30 }, (_, i) => `listed${String(i).padStart(2, '0')}`);
let adminToken: string, creatorToken: string;
const session = async (userId: string) => {
  const token = randomBytes(32).toString('base64url');
  await db.session.create({
    data: {
      userId,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  return token;
};
test.beforeAll(async () => {
  assertTestDatabase();
  await truncateAll(db);
  const admin = await db.user.create({
    data: { xId: 'gate-admin-x', handle: 'gate_admin', role: 'ADMIN' },
  });
  adminToken = await session(admin.id);
  for (const [i, handle] of names.entries())
    await db.user.create({
      data: {
        xId: `listed-x-${i}`,
        handle,
        approved: i % 2 === 0,
        affiliation: i % 2 ? `Project ${handle}` : '',
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
      },
    });
  const outsider = await db.user.findFirstOrThrow({ where: { handle: 'listed00' } });
  creatorToken = await session(outsider.id);
});
test.afterAll(async () => {
  await truncateAll(db);
  await db.$disconnect();
});
test('admin lists paginate, search and filter on the server', async ({ page }) => {
  const problems = watchConsole(page);
  await page
    .context()
    .addCookies([{ name: 'raid_session', value: adminToken, url: 'http://localhost:3006' }]);
  await page.goto('/admin');
  const rows = page.locator('#creators .admin-row');
  await expect(rows).toHaveCount(25);
  await expect(page.locator('#creators')).not.toContainText('@gate_admin');
  await expect(rows.first()).toContainText('Pending');
  await page.locator('#creators').getByRole('link', { name: 'Next' }).click();
  await expect(page).toHaveURL(/creatorPage=2#creators/);
  await expect(rows).toHaveCount(5);
  await expect(page.locator('#creators').getByRole('link', { name: 'Next' })).toHaveCount(0);
  await page.locator('#creators').getByRole('link', { name: 'Previous' }).click();
  await expect(rows).toHaveCount(25);
  await page.getByRole('searchbox', { name: 'Search operations' }).fill('LISTED07');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('@listed07');
  await page.goto('/admin?creators=pending');
  await expect(rows).toHaveCount(15);
  await page.waitForLoadState('networkidle');
  expect(problems).toEqual([]);
});
test('non-admin creators are denied the operations page', async ({ page }) => {
  await page
    .context()
    .addCookies([{ name: 'raid_session', value: creatorToken, url: 'http://localhost:3006' }]);
  await page.goto('/admin');
  await expect(page.getByText('Administrator access is required')).toBeVisible();
  await expect(page.locator('#creators')).toHaveCount(0);
});
