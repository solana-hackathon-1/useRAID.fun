import { test, expect } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { db } from '../../src/lib/db';
import { assertTestDatabase, truncateAll } from '../helpers/db-guard';
import { expectCleanPage } from '../helpers/page-checks';
const mint = 'So11111111111111111111111111111111111111112';
let raidId: string, adminToken: string, creatorToken: string;
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
const login = (page: import('@playwright/test').Page, value: string) =>
  page.context().addCookies([{ name: 'raid_session', value, url: 'http://localhost:3006' }]);
test.beforeAll(async () => {
  assertTestDatabase();
  await truncateAll(db);
  const admin = await db.user.create({
    data: { xId: 'gate-admin-x', handle: 'gate_admin', role: 'ADMIN' },
  });
  const creator = await db.user.create({
    data: { xId: 'pages-creator-x', handle: 'pages_creator', approved: true },
  });
  await db.token.create({
    data: { mint, name: 'Pages Token', symbol: 'PAGES', metadataSource: 'MARKET' },
  });
  raidId = (
    await db.raid.create({
      data: {
        creatorId: creator.id,
        tag: 'raid_pages',
        title: 'Pages Raid',
        description: 'Page coverage fixture.',
        mint,
        startsAt: new Date(Date.now() - 3600000),
        endsAt: new Date(Date.now() + 3600000),
        status: 'ACTIVE',
      },
    })
  ).id;
  adminToken = await session(admin.id);
  creatorToken = await session(creator.id);
});
test.afterAll(async () => {
  await truncateAll(db);
  await db.$disconnect();
});
for (const path of ['/', '/methodology', '/privacy', '/launch'])
  test(`${path} loads cleanly with the database`, async ({ page }, testInfo) => {
    await expectCleanPage(page, path, testInfo);
  });
test('/launch shows Coming soon', async ({ page }) => {
  await page.goto('/launch');
  await expect(page.locator('main').getByText('Coming soon').first()).toBeVisible();
});
test('a database Raid and its token page load cleanly', async ({ page }, testInfo) => {
  await expectCleanPage(page, `/raids/${raidId}`, testInfo);
  await expect(page.getByRole('heading', { name: 'Pages Raid' }).first()).toBeVisible();
  await expectCleanPage(page, `/tokens/${mint}`, testInfo);
  await expect(page.getByText('PAGES').first()).toBeVisible();
});
test('/admin shows the operations cards to an administrator', async ({ page }, testInfo) => {
  await login(page, adminToken);
  await expectCleanPage(page, '/admin', testInfo);
  for (const id of ['usdc-payments', 'usdc-reconciliation', 'finance', 'creators'])
    await expect(page.locator(`#${id}`)).toBeAttached();
  await expect(page.locator('#finance').getByText('Coming soon')).toBeVisible();
});
test('/admin denies a non-admin creator', async ({ page }) => {
  await login(page, creatorToken);
  await page.goto('/admin');
  await expect(page.getByText('Administrator access is required')).toBeVisible();
});
test('/studio-test is not found outside the sandbox', async ({ page }) => {
  await page.goto('/studio-test');
  await expect(page.getByRole('heading', { name: 'This signal couldn’t be found.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Test Creator Studio' })).toHaveCount(0);
});

for (const width of [320, 390])
  test(`authenticated header fits a ${width}px viewport and menus remain usable`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await login(page, creatorToken);
    await page.goto('/');
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const navigation = page.getByRole('button', { name: 'Open menu', exact: true });
    await expect(navigation).toBeVisible();
    await navigation.click();
    await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(navigation).toBeFocused();
    const account = page.locator('.studio-account-trigger');
    await account.click();
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.keyboard.press('Escape');
    await expect(account).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
