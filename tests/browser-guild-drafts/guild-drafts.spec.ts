import { test, expect } from '@playwright/test';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { db } from '../../src/lib/db';
import { assertTestDatabase, truncateAll } from '../helpers/db-guard';
const baseURL = process.env.GUILD_DRAFT_BROWSER_URL || 'http://localhost:3016';
let token: string;
const profile = {
  name: 'Synthetic private Guild',
  slug: 'synthetic-guild',
  description: 'Synthetic private draft description',
};
test.beforeEach(async ({ page }) => {
  assertTestDatabase();
  await truncateAll(db);
  const user = await db.user.create({ data: { handle: 'synthetic_guild_form' } });
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
  await page.getByLabel('Guild name', { exact: true }).fill(profile.name);
  await page.getByLabel('Draft URL', { exact: true }).fill(profile.slug);
  await page.getByLabel('Description', { exact: true }).fill(profile.description);
}
async function create(page: import('@playwright/test').Page) {
  await page.goto('/creator/guild-drafts/new');
  await expect(
    page.getByRole('heading', { name: 'Private Guild draft', exact: true }),
  ).toBeVisible();
  await fill(page);
  await page.getByRole('button', { name: 'Save private draft', exact: true }).click();
  await expect(page.locator('form').getByRole('status')).toContainText('Draft saved');
  return page.getByRole('link', { name: 'Open saved draft', exact: true }).getAttribute('href');
}
test('creates an unverified private draft, edits the saved record and reloads its stable revision', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const href = await create(page);
  expect(href).toMatch(/^\/creator\/guild-drafts\/[a-f0-9-]{36}$/);
  await page.goto(href!);
  await expect(page.getByLabel('Guild name', { exact: true })).toHaveValue(profile.name);
  await expect(page.getByLabel('Draft URL', { exact: true })).toBeDisabled();
  await page.getByLabel('Description', { exact: true }).fill('Updated synthetic description');
  await page.getByRole('button', { name: 'Save private draft', exact: true }).click();
  await expect(page.locator('form').getByRole('status')).toContainText('Draft saved');
  await page.reload();
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue(
    'Updated synthetic description',
  );
  await expect(
    page.getByText('Founder control has not been verified.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('This draft stays private.', { exact: true })).toBeVisible();
  expect(await db.commandReceipt.count()).toBe(2);
  expect(await db.outboxEvent.count()).toBe(0);
  expect(await db.participant.count()).toBe(0);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath('guild-draft.png'), fullPage: true });
});
test('retains the original command through a committed lost response and temporary rate denial', async ({
  page,
}) => {
  await page.goto('/creator/guild-drafts/new');
  await fill(page);
  const attempts: { key: string | null; body: unknown }[] = [];
  await page.route('**/api/v1/guild-drafts', async (route) => {
    attempts.push({
      key: route.request().headers()['idempotency-key'],
      body: route.request().postDataJSON(),
    });
    if (attempts.length === 1) {
      const committed = await route.fetch();
      expect(committed.status()).toBe(200);
      await route.abort('failed');
    } else if (attempts.length === 2)
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'RATE_LIMITED' } }),
      });
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Save private draft', exact: true }).click();
  await expect(page.locator('form').getByRole('alert')).toContainText('Retry');
  await expect(page.locator('form').getByRole('alert')).toBeFocused();
  await expect(page.getByLabel('Guild name', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect(page.locator('form').getByRole('alert')).toContainText('same draft');
  await expect(page.getByLabel('Guild name', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect(page.locator('form').getByRole('status')).toContainText('Draft saved');
  expect(attempts).toHaveLength(3);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(attempts[2]).toEqual(attempts[0]);
  expect(attempts[0].key).toBeTruthy();
  expect(await db.commandReceipt.count()).toBe(1);
  expect(await db.outboxEvent.count()).toBe(0);
});
test('preserves local fields on stale revision, shows saved changes and accepts a reviewed retry', async ({
  page,
}) => {
  const href = await create(page);
  await page.goto(href!);
  await page.getByLabel('Description', { exact: true }).fill('Local draft survives conflict');
  const id = href!.split('/').pop();
  const updated = await page.request.post('/api/v1/guild-drafts', {
    headers: { Origin: baseURL, 'Idempotency-Key': randomUUID() },
    data: {
      guildDraftId: id,
      expectedRevision: 1,
      profile: { ...profile, name: 'Another saved name' },
    },
  });
  expect(updated.status()).toBe(200);
  await page.getByRole('button', { name: 'Save private draft', exact: true }).click();
  await expect(page.locator('form').getByRole('alert')).toContainText('Reload');
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue(
    'Local draft survives conflict',
  );
  await page.getByRole('button', { name: 'Reload saved revision', exact: true }).click();
  await expect(page.locator('form').getByRole('status')).toContainText('Your draft is preserved');
  await expect(page.getByText('Another saved name', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue(
    'Local draft survives conflict',
  );
  await page.getByRole('button', { name: 'Save private draft', exact: true }).click();
  await expect(page.locator('form').getByRole('status')).toContainText('Draft saved');
  expect(await db.commandReceipt.count()).toBe(3);
});
test('shows private-safe anonymous and foreign views and permits a corrected unavailable slug', async ({
  page,
  browser,
}) => {
  const href = await create(page);
  const outsider = await browser.newContext();
  try {
    const anon = await outsider.newPage();
    await anon.goto(href!);
    await expect(anon.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
    expect(await anon.content()).not.toContain(profile.description);
    const other = await db.user.create({ data: { handle: 'synthetic_other_owner' } }),
      cookie = randomBytes(32).toString('base64url');
    await db.session.create({
      data: {
        userId: other.id,
        tokenHash: createHash('sha256').update(cookie).digest('hex'),
        via: 'wallet',
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    await outsider.addCookies([{ name: 'raid_session', value: cookie, url: baseURL }]);
    await anon.reload();
    await expect(anon.locator('.studio').getByRole('alert')).toContainText('could not be loaded');
    expect(await anon.content()).not.toContain(profile.description);
    await anon.goto('/creator/guild-drafts/new');
    await fill(anon);
    await anon.getByRole('button', { name: 'Save private draft', exact: true }).click();
    await expect(anon.locator('form').getByRole('alert')).toContainText('unavailable');
    await expect(anon.getByLabel('Description', { exact: true })).toHaveValue(profile.description);
    await anon.getByLabel('Draft URL', { exact: true }).fill('another-private-guild');
    await anon.getByRole('button', { name: 'Save private draft', exact: true }).click();
    await expect(anon.locator('form').getByRole('status')).toContainText('Draft saved');
    expect(await db.commandReceipt.count()).toBe(2);
  } finally {
    await outsider.close();
  }
});
