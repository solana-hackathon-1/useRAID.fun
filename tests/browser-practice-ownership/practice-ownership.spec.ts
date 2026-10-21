import { test, expect } from '@playwright/test';
import { seedPracticeOwnershipFixture, db } from '../helpers/practice-ownership-browser-fixture';
const baseURL = process.env.PRACTICE_OWNERSHIP_BROWSER_URL || 'http://127.0.0.1:3029';
test.afterAll(() => db.$disconnect());
async function fill(
  page: import('@playwright/test').Page,
  decision = 'CONFIRM',
  reason = 'Synthetic ownership explanation. <img src="/ownership-inert">',
) {
  await page.getByLabel('Finding', { exact: true }).selectOption(decision);
  await page.getByLabel('Reason', { exact: true }).fill(reason);
  await page
    .getByLabel('Observation 1', { exact: true })
    .fill('Synthetic bounded explanation observation.');
}
test('appointed evaluator saves, rechecks and corrects a finding using exact source', async ({
  page,
}, info) => {
  const f = await seedPracticeOwnershipFixture();
  await page.context().addCookies([{ name: 'raid_session', value: f.cookie, url: baseURL }]);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fetched: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('ownership-inert')) fetched.push(r.url());
  });
  const response = await page.goto(f.path);
  await expect(page.getByRole('heading', { name: 'Record ownership finding' })).toBeVisible();
  if (process.env.PRACTICE_OWNERSHIP_SERVER_MODE === 'production') {
    expect(response?.headers()['cache-control']).toContain('no-store');
    expect(response?.headers()['cache-control']).toContain('private');
  }
  expect(await page.title()).not.toContain(f.definition.title);
  expect(await page.locator('meta[name=robots]').getAttribute('content')).toContain('noindex');
  await expect(page.getByText(/Synthetic approved ownership guidance/)).toBeVisible();
  const labelBox = await page.locator('label[for=ownership-decision]').boundingBox();
  const controlBox = await page.getByLabel('Finding', { exact: true }).boundingBox();
  expect(labelBox && controlBox && labelBox.y + labelBox.height <= controlBox.y).toBe(true);
  await fill(page);
  await page.getByRole('button', { name: 'Save finding', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Finding saved' })).toBeVisible();
  await expect(page.getByText(/CONFIRMED · version 1/)).toBeVisible();
  await expect(page.getByText(/Original ownership declaration: Unconfirmed/)).toBeVisible();
  await page.getByRole('button', { name: 'Recheck current case' }).click();
  await expect(page.getByRole('heading', { name: 'Record ownership finding' })).toBeVisible();
  await fill(page, 'MORE_EVIDENCE', 'Synthetic reasoned correction.');
  await page.getByRole('button', { name: 'Save finding', exact: true }).click();
  await expect(page.getByText(/UNCONFIRMED · version 2/)).toBeVisible();
  expect(await db.practiceTrialOwnershipVersion.count()).toBe(2);
  expect(fetched).toEqual([]);
  expect(errors).toEqual([]);
  expect(await page.locator('body').evaluate((e) => e.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('ownership-saved.png'), fullPage: true });
});
test('uncertain response retries identical command after approved policy withdrawal', async ({
  page,
}) => {
  const f = await seedPracticeOwnershipFixture();
  await page.context().addCookies([{ name: 'raid_session', value: f.cookie, url: baseURL }]);
  const requests: { key: string | undefined; body: string | null }[] = [];
  await page.route('**/api/v1/practice/reviews/**/ownership', async (route) => {
    requests.push({
      key: route.request().headers()['idempotency-key'],
      body: route.request().postData(),
    });
    const response = await route.fetch();
    if (requests.length === 1) {
      expect(response.status()).toBe(200);
      await route.abort('failed');
    } else await route.fulfill({ response });
  });
  await page.goto(f.path);
  await fill(page);
  await page.getByRole('button', { name: 'Save finding', exact: true }).click();
  await expect(page.getByText(/Save status is uncertain/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Recheck current case' })).toBeDisabled();
  await f.saveOutsideBrowser(f.submission.reference);
  await f.withdraw();
  await page.getByRole('button', { name: 'Retry same request' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Finding saved' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Saved finding (historical)' })).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(await db.practiceTrialOwnershipVersion.count()).toBe(2);
});
test('stale finding requires recheck and revoked access hides visible private context', async ({
  page,
}) => {
  const f = await seedPracticeOwnershipFixture();
  await page.context().addCookies([{ name: 'raid_session', value: f.cookie, url: baseURL }]);
  await page.goto(f.path);
  await fill(page);
  await f.saveOutsideBrowser();
  await page.getByRole('button', { name: 'Save finding', exact: true }).click();
  await expect(page.getByText(/The policy or finding changed/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save finding', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Recheck current case' }).click();
  await expect(page.getByText('Synthetic concurrent finding.', { exact: true })).toBeVisible();
  await fill(page);
  await f.revoke();
  await page.getByRole('button', { name: 'Save finding', exact: true }).click();
  await expect(page.getByText(/Access to this case is unavailable/)).toBeVisible();
  await expect(page.getByText(/Synthetic approved ownership guidance/)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Original submission' })).toHaveCount(0);
});
test('missing policy, signed-out account and wrong evaluator never offer a new finding', async ({
  page,
}) => {
  const f = await seedPracticeOwnershipFixture(false);
  const response = await page.goto(f.path);
  await expect(page.getByText('Sign in to view this assigned case.')).toBeVisible();
  expect(await response?.text()).not.toContain('review-private-answer-marker');
  await page.context().addCookies([{ name: 'raid_session', value: f.cookie, url: baseURL }]);
  await page.goto(f.path);
  await expect(page.getByText(/No approved policy/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save finding', exact: true })).toHaveCount(0);
  await f.signOut();
  await page.reload();
  await expect(page.getByText('Sign in to view this assigned case.')).toBeVisible();
  await expect(page.getByText(/Synthetic approved ownership guidance/)).toHaveCount(0);
  const { hash } = await import('../../src/lib/auth-primitives');
  const foreignCookie = crypto.randomUUID();
  await db.session.create({
    data: {
      tokenHash: hash(foreignCookie),
      userId: f.assignment.issuedByAccountId,
      via: 'x',
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  await page.context().clearCookies();
  await page.context().addCookies([{ name: 'raid_session', value: foreignCookie, url: baseURL }]);
  const foreign = await page.goto(f.path);
  await expect(page.getByRole('heading', { name: /not found/i })).toBeVisible();
  expect(await foreign?.text()).not.toContain('review-private-answer-marker');
});
