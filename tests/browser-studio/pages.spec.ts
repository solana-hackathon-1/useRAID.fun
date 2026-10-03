import { test, expect, type Page } from '@playwright/test';
import { expectCleanPage } from '../helpers/page-checks';
const login = async (page: Page, fixtureId: string) => {
  const response = await page.request.post('/api/studio/sandbox', {
    headers: { origin: 'http://localhost:3007' },
    data: { action: 'login', fixtureId },
  });
  expect(response.ok()).toBe(true);
};
test.describe('approved creator', () => {
  let draftId: string;
  test.beforeEach(async ({ page }) => {
    await login(page, crypto.randomUUID());
    await page.goto('/creator/new');
    await page.getByRole('button', { name: /X Campaign No token needed/ }).click();
    await page.getByLabel('Campaign name', { exact: true }).fill(`Page check ${Date.now()}`);
    await page
      .getByLabel('X post 1', { exact: true })
      .fill('https://x.com/project/status/123456789123456795');
    await expect(page.getByText(/no single raider can earn more than 25%/)).toBeVisible();
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
    await page.waitForURL(/\/creator\/new\?draft=/);
    draftId = new URL(page.url()).searchParams.get('draft')!;
  });
  for (const path of ['/creator', '/creator/new', '/creator/account', '/creator/balance'])
    test(`${path} loads cleanly`, async ({ page }, testInfo) => {
      await expectCleanPage(page, path, testInfo);
    });
  test('/creator lists the saved draft', async ({ page }, testInfo) => {
    await expectCleanPage(page, '/creator', testInfo);
    await expect(page.locator('.studio-raid-row').first()).toBeVisible();
  });
  test('/creator/new reopens the draft with the payout cap copy', async ({ page }, testInfo) => {
    await expectCleanPage(page, `/creator/new?draft=${draftId}`, testInfo);
    await expect(page.getByText(/no single raider can earn more than 25%/)).toBeVisible();
  });
  test('/creator/raids/[id] loads cleanly', async ({ page }, testInfo) => {
    await expectCleanPage(page, `/creator/raids/${draftId}`, testInfo);
  });
  test('/creator/balance shows the balance', async ({ page }) => {
    await page.goto('/creator/balance');
    await expect(page.getByText('USDC').first()).toBeVisible();
  });
});
test.describe('unapproved creator', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, `unapproved-${crypto.randomUUID()}`);
  });
  for (const path of ['/creator', '/creator/new'])
    test(`${path} shows the approval request`, async ({ page }, testInfo) => {
      await expectCleanPage(page, path, testInfo);
      await expect(page.getByRole('heading', { name: 'Creator approval required' })).toBeVisible();
      await expect(page.getByLabel('Project affiliation')).toBeVisible();
    });
  for (const path of ['/creator/account', '/creator/balance'])
    test(`${path} loads cleanly`, async ({ page }, testInfo) => {
      await expectCleanPage(page, path, testInfo);
    });
});
test('/studio-test loads cleanly in the sandbox', async ({ page }, testInfo) => {
  await expectCleanPage(page, '/studio-test', testInfo);
  await expect(page.getByRole('heading', { name: 'Test Creator Studio' })).toBeVisible();
});
