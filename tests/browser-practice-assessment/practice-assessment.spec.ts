import { test, expect, type Page } from '@playwright/test';
import { seedPracticeAssessmentFixture, db } from '../helpers/practice-assessment-browser-fixture';
const baseURL = process.env.PRACTICE_ASSESSMENT_BROWSER_URL || 'http://127.0.0.1:3030';
test.afterAll(() => db.$disconnect());
async function review(page: Page, outcome = 'VERIFY') {
  await page.getByLabel('Review outcome', { exact: true }).selectOption(outcome);
  await page
    .getByLabel('Review reason', { exact: true })
    .fill('Synthetic assessment explanation. <img src="/assessment-inert">');
  await page
    .getByLabel('Confidence statement', { exact: true })
    .fill('One original synthetic case only.');
  for (const select of await page.locator('select[id^=assessment-result-]').all())
    await select.selectOption('MET');
  for (const reason of await page.locator('textarea[id^=assessment-criterion-]').all())
    await reason.fill('Specific original criterion met.');
}
async function decide(page: Page, action = 'REQUIRE_REASSESSMENT') {
  await page.getByLabel('State action', { exact: true }).selectOption(action);
  await page
    .getByLabel('State decision reason', { exact: true })
    .fill('Synthetic reasoned current-state decision.');
  await page
    .getByLabel('Finding 1 type', { exact: true })
    .selectOption(action === 'REVOKE' ? 'ASSESSMENT_EVIDENCE' : 'CAPABILITY_EVIDENCE');
  await page.getByLabel('Finding 1', { exact: true }).fill('Synthetic specific reviewed evidence.');
  if (action !== 'REVOKE')
    await page
      .getByLabel('Reassessment due date (UTC)', { exact: true })
      .fill(new Date(Date.now() + 3600000).toISOString());
}
async function open(page: Page, f: Awaited<ReturnType<typeof seedPracticeAssessmentFixture>>) {
  await page.context().addCookies([{ name: 'raid_session', value: f.cookie, url: baseURL }]);
  return page.goto(f.path);
}
async function saved(page: Page) {
  await expect(page.getByRole('status').filter({ hasText: 'Assessment saved' })).toBeVisible();
}
test('actual original-case verify, nonverification, reassessment and revocation preserve history', async ({
  page,
}, info) => {
  const f = await seedPracticeAssessmentFixture();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const inert: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('assessment-inert')) inert.push(r.url());
  });
  const response = await open(page, f);
  if (process.env.PRACTICE_ASSESSMENT_SERVER_MODE === 'production') {
    expect(response?.headers()['cache-control']).toContain('private');
    expect(response?.headers()['cache-control']).toContain('no-store');
  }
  await expect(page.getByText(/Synthetic approved assessment guidance/)).toBeVisible();
  expect(await page.title()).not.toContain(f.definition.title);
  expect(await page.locator('meta[name=robots]').getAttribute('content')).toContain('noindex');
  const labelBox = await page.locator('label[for=assessment-decision]').boundingBox();
  const controlBox = await page.getByLabel('Review outcome', { exact: true }).boundingBox();
  expect(labelBox && controlBox && labelBox.y + labelBox.height <= controlBox.y).toBe(true);
  await review(page);
  await page.getByRole('button', { name: 'Save assessment review', exact: true }).focus();
  await page.keyboard.press('Enter');
  await saved(page);
  await expect(page.getByText(/Saved skill state: VERIFIED/)).toBeVisible();
  await page.getByRole('button', { name: 'Recheck current case' }).click();
  await review(page, 'MORE_EVIDENCE');
  await page.getByRole('button', { name: 'Save assessment review', exact: true }).click();
  await saved(page);
  await page.getByRole('button', { name: 'Recheck current case' }).click();
  await expect(page.getByText(/Current skill state: VERIFIED/)).toBeVisible();
  await decide(page);
  await page.getByRole('button', { name: 'Save state decision', exact: true }).click();
  await saved(page);
  await expect(page.getByText(/REASSESSMENT_REQUIRED · version 2/)).toBeVisible();
  await page.getByRole('button', { name: 'Recheck current case' }).click();
  await decide(page, 'REVOKE');
  await page.getByRole('button', { name: 'Save state decision', exact: true }).click();
  await saved(page);
  await expect(page.getByText(/REVOKED · version 3/)).toBeVisible();
  await page.getByRole('button', { name: 'Recheck current case' }).click();
  await expect(page.getByRole('heading', { name: 'Record assessment state decision' })).toHaveCount(
    0,
  );
  await expect(page.getByText(/Original ownership declaration: Unconfirmed/)).toBeVisible();
  expect(await db.skillAssessmentVersion.count()).toBe(3);
  expect(await db.practiceAssessmentReviewVersion.count()).toBe(2);
  expect(inert).toEqual([]);
  expect(errors).toEqual([]);
  expect(await page.locator('body').evaluate((e) => e.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('assessment-current.png'), fullPage: true });
});
test('lost review response replays identical command after later review and policy withdrawal', async ({
  page,
}) => {
  const f = await seedPracticeAssessmentFixture();
  const requests: { key: string | undefined; body: string | null }[] = [];
  await page.route('**/api/v1/practice/reviews/**/assessment', async (route) => {
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
  await open(page, f);
  await review(page);
  await page.getByRole('button', { name: 'Save assessment review', exact: true }).click();
  await expect(page.getByText(/Save status is uncertain/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Recheck current case' })).toBeDisabled();
  await f.saveReviewOutside();
  await f.withdraw();
  await page.getByRole('button', { name: 'Retry same request' }).click();
  await saved(page);
  await expect(page.getByRole('heading', { name: 'Saved review (historical)' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Observed before save: Approved assessment policy' }),
  ).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(await db.skillAssessmentVersion.count()).toBe(1);
});
test('lost state decision replays original history after newer revocation and withdrawal', async ({
  page,
}) => {
  const f = await seedPracticeAssessmentFixture();
  await open(page, f);
  await review(page);
  await page.getByRole('button', { name: 'Save assessment review', exact: true }).click();
  await saved(page);
  await page.getByRole('button', { name: 'Recheck current case' }).click();
  const requests: { key: string | undefined; body: string | null }[] = [];
  await page.route('**/api/v1/practice/reviews/**/assessment/decisions', async (route) => {
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
  await decide(page);
  await page.getByRole('button', { name: 'Save state decision', exact: true }).click();
  await expect(page.getByText(/Save status is uncertain/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Recheck current case' })).toBeDisabled();
  await f.revokeStateOutside();
  await f.withdraw();
  await page.getByRole('button', { name: 'Retry same request' }).click();
  await saved(page);
  await expect(page.getByRole('heading', { name: 'Saved decision (historical)' })).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(await db.skillAssessmentVersion.count()).toBe(3);
});
test('stale review requires recheck and revoked appointment clears visible private context', async ({
  page,
}) => {
  const f = await seedPracticeAssessmentFixture();
  await open(page, f);
  await review(page);
  await f.saveReviewOutside();
  await page.getByRole('button', { name: 'Save assessment review', exact: true }).click();
  await expect(page.getByText(/The case, policy or assessment changed/)).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Save assessment review', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Recheck current case' }).click();
  await review(page);
  await f.revoke();
  await page.getByRole('button', { name: 'Save assessment review', exact: true }).click();
  await expect(page.getByText(/Access to this case is unavailable/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Original submission' })).toHaveCount(0);
  await expect(page.getByText(/Synthetic approved assessment guidance/)).toHaveCount(0);
});
test('missing policy and signed-out sessions expose no action or private source', async ({
  page,
}) => {
  const f = await seedPracticeAssessmentFixture(false);
  const response = await page.goto(f.path);
  await expect(page.getByText('Sign in to view this assigned case.')).toBeVisible();
  expect(await response?.text()).not.toContain('review-private-answer-marker');
  await open(page, f);
  await expect(page.getByText(/No approved policy/)).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Save assessment review', exact: true }),
  ).toHaveCount(0);
  await f.signOut();
  await page.reload();
  await expect(page.getByText('Sign in to view this assigned case.')).toBeVisible();
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
