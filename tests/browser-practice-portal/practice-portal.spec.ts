import { test, expect, type Page } from '@playwright/test';
import { seedPracticePortalFixture, db } from '../helpers/practice-portal-fixture';
const baseURL = process.env.PRACTICE_PORTAL_BROWSER_URL || 'http://127.0.0.1:3026';
let fixture: Awaited<ReturnType<typeof seedPracticePortalFixture>>;
test.afterAll(() => db.$disconnect());
async function signIn(page: Page, f = fixture) {
  await page.context().addCookies([{ name: 'raid_session', value: f.cookie, url: baseURL }]);
}
function watch(page: Page) {
  const errors: string[] = [],
    hydration: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && /hydrat|server rendered HTML/i.test(m.text()))
      hydration.push(m.text());
  });
  return { errors, hydration };
}
const noOverflow = (page: Page) =>
  page.locator('body').evaluate((e) => e.scrollWidth <= window.innerWidth);

test('browse, start, submit privately, and reload the saved submission', async ({ page }, info) => {
  fixture = await seedPracticePortalFixture();
  await signIn(page);
  const { errors, hydration } = watch(page);
  const response = await page.goto('/raider/practice');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Practice trials', level: 1 })).toBeVisible();
  const card = page.getByRole('article', { name: 'Synthetic interface exercise' });
  await expect(card.getByText('not a deadline')).toBeVisible();
  await expect(page.getByText(/does not verify a skill/)).toBeVisible();
  const start = card.getByRole('button', { name: 'Start practice' });
  await expect(start).toBeEnabled();
  await start.focus();
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/raider\/practice\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Attempt 1')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit answer' })).toBeEnabled();
  // Blank submit: nothing leaves the browser.
  let posted = 0;
  page.on('request', (r) => r.method() === 'POST' && /submission$/.test(r.url()) && posted++);
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.locator('p[role="alert"]')).toContainText('Check the form');
  expect(posted).toBe(0);
  await page.getByLabel('Answer', { exact: true }).fill('const x = "<b>exact</b>";\nsecond line');
  await page.getByLabel('Explanation').fill('I built this myself and can modify it.');
  await page.getByLabel('Tools used').fill('editor\nbrowser');
  await page.getByLabel('Assistance disclosure').fill('No assistance used.');
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByText(/Your work has not been reviewed yet/)).toBeVisible();
  await expect(page.getByText('const x = "<b>exact</b>";', { exact: false })).toBeVisible();
  await expect(page.locator('form')).toHaveCount(0);
  expect(posted).toBe(1);
  await page.reload();
  await expect(page.getByText(/Your work has not been reviewed yet/)).toBeVisible();
  await expect(page.getByText('I built this myself and can modify it.')).toBeVisible();
  // No verification, rank, or payment claim anywhere in the submitted view.
  const text = (await page.locator('main, body').first().innerText()).toLowerCase();
  expect(text).not.toMatch(/you passed|rank earned|payout|reward/);
  // The API never exposes session material or another participant's data.
  const api = await page.request.get(
    page.url().replace('/raider/practice/', '/api/v1/practice/starts/'),
  );
  expect(api.status()).toBe(200);
  expect(api.headers()['cache-control']).toBe('private, no-store');
  const body = JSON.stringify(await api.json());
  expect(body).not.toContain('sessionHash');
  expect(await noOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
  expect(hydration).toEqual([]);
  await page.screenshot({ path: info.outputPath('submitted.png'), fullPage: true });
});

test('continue an existing attempt after reload; stays continuable after the trial is retired', async ({
  page,
}, info) => {
  fixture = await seedPracticePortalFixture();
  const startId = await fixture.startOutsideBrowser();
  await fixture.retire();
  await signIn(page);
  const { errors, hydration } = watch(page);
  // Retired trials are not offered for new starts.
  await page.goto('/raider/practice');
  await expect(page.getByText('No practice trials are available')).toBeVisible();
  // The accepted attempt keeps its original terms and remains submittable.
  await page.goto('/raider/practice/' + startId);
  await expect(page.getByText('Synthetic interface exercise').first()).toBeVisible();
  await page.getByLabel('Answer', { exact: true }).fill('late answer');
  await page.getByLabel('Explanation').fill('still mine');
  await page.getByLabel('Assistance disclosure').fill('none');
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByText(/Your work has not been reviewed yet/)).toBeVisible();
  expect(await noOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
  expect(hydration).toEqual([]);
  await page.screenshot({ path: info.outputPath('continued.png'), fullPage: true });
});

test('signed-out and foreign access never reveal practice data', async ({ page, browser }) => {
  fixture = await seedPracticePortalFixture();
  const startId = await fixture.startOutsideBrowser();
  await page.goto('/raider/practice');
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByText('Synthetic interface exercise')).toHaveCount(0);
  await page.goto('/raider/practice/' + startId);
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByText('Synthetic interface exercise')).toHaveCount(0);
  // A different signed-in account cannot open this attempt.
  const other = await browser.newContext();
  const o = await other.newPage();
  const stranger = await db.user.create({ data: { handle: 'stranger', role: 'CREATOR' } });
  await db.participant.create({
    data: {
      accountId: stranger.id,
      provisionActorAccountId: stranger.id,
      provisionRequestId: 'synthetic-provision',
    },
  });
  const { randomBytes } = await import('node:crypto');
  const { hash } = await import('../../src/lib/auth-primitives');
  const cookie = randomBytes(32).toString('base64url');
  await db.session.create({
    data: {
      tokenHash: hash(cookie),
      userId: stranger.id,
      via: 'wallet',
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  await other.addCookies([{ name: 'raid_session', value: cookie, url: baseURL }]);
  // Root loading boundary streams first, so Next renders a soft 404 (200 + noindex); the API is the hard 404.
  await o.goto('/raider/practice/' + startId);
  await expect(o.getByRole('heading', { name: /couldn.t be found/ })).toBeVisible();
  await expect(o.getByText('Synthetic interface exercise')).toHaveCount(0);
  const api = await o.request.get('/api/v1/practice/starts/' + startId);
  expect(api.status()).toBe(404);
  await other.close();
});

test('AI declaration is unavailable when the original definition prohibits AI', async ({
  page,
}) => {
  fixture = await seedPracticePortalFixture({ ai: false });
  const startId = await fixture.startOutsideBrowser();
  await signIn(page);
  await page.goto('/raider/practice/' + startId);
  await expect(page.getByRole('checkbox', { name: /I used AI assistance/ })).toBeDisabled();
  await expect(page.getByText('AI assistance is prohibited for this trial.')).toBeVisible();
});
