import { test, expect } from '@playwright/test';
import { randomBytes, createHash } from 'node:crypto';
import { db } from '../../src/lib/db';
import { assertTestDatabase, truncateAll } from '../helpers/db-guard';
const baseURL = process.env.RAID_ONBOARDING_PREVIEW_URL || 'http://localhost:3014';
let token: string;
test.beforeEach(async ({ page }) => {
  assertTestDatabase();
  await truncateAll(db);
  const user = await db.user.create({ data: { handle: 'synthetic_orientation' } });
  token = randomBytes(32).toString('base64url');
  await db.session.create({
    data: {
      userId: user.id,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      via: 'wallet',
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  await page.context().addCookies([{ name: 'raid_session', value: token, url: baseURL }]);
});
test.afterAll(async () => {
  await truncateAll(db);
  await db.$disconnect();
});
async function fill(page: import('@playwright/test').Page) {
  await page.getByLabel('Quality assurance', { exact: true }).check();
  await page.getByLabel('Timezone', { exact: true }).fill('Asia/Kathmandu');
  await page.getByLabel('I understand these commitments').check();
}
test('saves private beginner preferences, reloads the stored version and shows honest next steps', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/raider/onboarding');
  await expect(
    page.getByRole('heading', { name: 'Raider orientation', exact: true }),
  ).toBeVisible();
  await fill(page);
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Preferences saved');
  await page.reload();
  await expect(page.getByLabel('Quality assurance', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Timezone', { exact: true })).toHaveValue('Asia/Kathmandu');
  await expect(
    page.getByText('Starter tasks are not available yet.', { exact: true }),
  ).toBeVisible();
  expect(await db.participant.count()).toBe(1);
  expect(await db.commandReceipt.count()).toBe(1);
  expect(await db.outboxEvent.count()).toBe(0);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath('orientation.png'), fullPage: true });
});
test('preserves the draft and request identity after a lost response, then safely replays once', async ({
  page,
}) => {
  await page.goto('/raider/onboarding');
  await fill(page);
  const attempts: { key: string | null; body: unknown }[] = [];
  let first = true;
  await page.route('**/api/v1/me/orientation', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    attempts.push({
      key: route.request().headers()['idempotency-key'],
      body: route.request().postDataJSON(),
    });
    if (first) {
      first = false;
      const committed = await route.fetch();
      expect(committed.status()).toBe(200);
      await route.abort('failed');
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await expect(page.locator('form').getByRole('alert')).toContainText('Retry');
  await expect(page.locator('form').getByRole('alert')).toBeFocused();
  await expect(page.getByLabel('Timezone', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Timezone', { exact: true })).toHaveValue('Asia/Kathmandu');
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Preferences saved');
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(attempts[0].key).toBeTruthy();
  expect(await db.commandReceipt.count()).toBe(1);
  expect(await db.participant.count()).toBe(1);
});
test('experienced portfolio input stays self-described and a rejected save preserves the draft', async ({
  page,
}) => {
  await page.goto('/raider/onboarding');
  await page.getByLabel('Experience', { exact: true }).selectOption('EXPERIENCED');
  await fill(page);
  await page.getByLabel('Portfolio URL (optional)').fill('https://portfolio.example/fixture');
  await page.route('**/api/v1/me/orientation', async (route) => {
    if (route.request().method() === 'POST')
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'REVISION_CHANGED',
            message: 'Refresh',
            retryable: false,
            requestId: 'synthetic-conflict',
          },
        }),
      });
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await expect(page.locator('form').getByRole('alert')).toContainText('changed');
  await expect(page.getByLabel('Portfolio URL (optional)')).toHaveValue(
    'https://portfolio.example/fixture',
  );
  await expect(
    page.getByRole('button', { name: 'Reload saved revision', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Reload saved revision', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('draft is preserved');
  await expect(page.getByLabel('Portfolio URL (optional)')).toHaveValue(
    'https://portfolio.example/fixture',
  );
  expect(await db.participant.count()).toBe(0);
  expect(await db.commandReceipt.count()).toBe(0);
});

test('anonymous HTML and API never disclose another account private preferences', async ({
  page,
  browser,
}) => {
  await page.goto('/raider/onboarding');
  await page.getByLabel('Experience', { exact: true }).selectOption('EXPERIENCED');
  await fill(page);
  const privateUrl = 'https://portfolio.example/synthetic-private-marker';
  await page.getByLabel('Portfolio URL (optional)').fill(privateUrl);
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Preferences saved');
  const anonymous = await browser.newContext();
  try {
    const response = await anonymous.request.get(baseURL + '/api/v1/me/orientation');
    expect(response.status()).toBe(401);
    expect(response.headers()['cache-control']).toBe('private, no-store');
    expect(await response.text()).not.toContain(privateUrl);
    const visitor = await anonymous.newPage();
    const html = await visitor.goto(baseURL + '/raider/onboarding');
    expect(html?.status()).toBe(200);
    await expect(visitor.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
    expect(await html!.text()).not.toContain(privateUrl);
    expect(await html!.text()).not.toContain('Asia/Kathmandu');
  } finally {
    await anonymous.close();
  }
});
