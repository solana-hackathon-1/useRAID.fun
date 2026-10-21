import { test, expect } from '@playwright/test';
import { seedPracticeReviewInboxFixture, db } from '../helpers/practice-review-inbox-fixture';
const baseURL = process.env.PRACTICE_REVIEW_INBOX_BROWSER_URL || 'http://127.0.0.1:3032';
test.afterAll(() => db.$disconnect());
test('own current inbox has minimal metadata and keyboard links to actual scoped original case and finding form', async ({
  page,
}, info) => {
  const f = await seedPracticeReviewInboxFixture();
  await page.context().addCookies([{ name: 'raid_session', value: f.cookie, url: baseURL }]);
  const response = await page.goto('/evaluator/practice');
  await expect(page.getByRole('heading', { name: 'Your practice reviews' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ownership review', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Skill assessment', exact: true })).toBeVisible();
  expect(await page.content()).not.toMatch(
    /review-private-answer-marker|review-private-explanation-marker|Synthetic inbox appointment only/,
  );
  expect(await page.locator('meta[name="robots"]').getAttribute('content')).toContain('noindex');
  if (process.env.PRACTICE_REVIEW_INBOX_SERVER_MODE === 'production') {
    expect(response?.headers()['cache-control']).toContain('private');
    expect(response?.headers()['cache-control']).toContain('no-store');
  }
  expect(
    await db.auditEvent.count({
      where: { actorId: f.evaluatorId, eventType: 'skill.practice_review_access_authorized.v1' },
    }),
  ).toBe(0);
  expect(await page.locator('body').evaluate((e) => e.scrollWidth <= window.innerWidth)).toBe(true);
  const api = await page.request.get('/api/v1/practice/reviews');
  expect(api.status()).toBe(200);
  expect(api.headers()['cache-control']).toBe('private, no-store');
  expect(api.headers()['vary']).toContain('Cookie');
  const body = await api.json();
  expect(body.entries).toHaveLength(2);
  expect(JSON.stringify(body)).not.toMatch(/accountId|answer|reason|definition|rubric/);
  const head = await page.request.head('/api/v1/practice/reviews');
  expect(head.status()).toBe(200);
  expect(await head.text()).toBe('');
  await page.screenshot({ path: info.outputPath('inbox.png'), fullPage: true });
  const own = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name: 'Ownership review', exact: true }) });
  await own.getByRole('link', { name: 'Read original case' }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Original submission', exact: true }),
  ).toBeVisible();
  await page.goto('/evaluator/practice');
  await page.getByRole('link', { name: 'Review ownership', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Ownership review', exact: true, level: 1 }),
  ).toBeVisible();
  await expect(page.getByText(/review-private-explanation-marker/)).toBeVisible();
  await page.goto('/evaluator/practice');
  await page.getByRole('link', { name: 'Review assessment', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Assessment review', exact: true, level: 1 }),
  ).toBeVisible();
  await expect(page.getByText(/review-private-explanation-marker/)).toBeVisible();
});
test('pagination retains current own ordering and refresh returns to first page', async ({
  page,
}) => {
  const f = await seedPracticeReviewInboxFixture(23);
  await page.context().addCookies([{ name: 'raid_session', value: f.cookie, url: baseURL }]);
  await page.goto('/evaluator/practice');
  await expect(page.getByRole('listitem')).toHaveCount(20);
  const ids = await page.getByRole('listitem').locator('code').allTextContents();
  await page.getByRole('link', { name: 'More assignments' }).click();
  await expect(page.getByRole('listitem')).toHaveCount(3);
  const rest = await page.getByRole('listitem').locator('code').allTextContents();
  expect(new Set([...ids, ...rest]).size).toBe(23);
  expect([...ids, ...rest]).toEqual([...ids, ...rest].sort());
  await page.getByRole('button', { name: 'Refresh assignments' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listitem')).toHaveCount(20);
  expect(new URL(page.url()).search).toBe('');
});
test('revocation and signout remove current metadata on refresh; visitor API is private401', async ({
  page,
}) => {
  const f = await seedPracticeReviewInboxFixture(1);
  await page.context().addCookies([{ name: 'raid_session', value: f.cookie, url: baseURL }]);
  await page.goto('/evaluator/practice');
  await expect(page.getByRole('listitem')).toHaveCount(1);
  await f.revoke();
  await page.getByRole('button', { name: 'Refresh assignments' }).click();
  await expect(page.getByText(/No current assignments/)).toBeVisible();
  expect(await page.content()).not.toContain(f.assignment.id);
  await f.signOut();
  await page.getByRole('button', { name: 'Refresh assignments' }).click();
  await expect(page.getByText(/Sign in to view your current/)).toBeVisible();
  expect(await page.content()).not.toContain(f.assignment.id);
  const response = await page.request.get('/api/v1/practice/reviews?evaluatorAccountId=foreign');
  expect(response.status()).toBe(401);
  expect(response.headers()['cache-control']).toBe('private, no-store');
});
test('current administrator has no evaluator assignments; actor query cannot select another inbox', async ({
  page,
}) => {
  const f = await seedPracticeReviewInboxFixture();
  const s = await db.session.findFirstOrThrow({ where: { via: 'x' } });
  const { hash } = await import('../../src/lib/auth-primitives');
  const cookie = 'synthetic-inbox-admin-cookie';
  await db.session.create({
    data: {
      tokenHash: hash(cookie),
      userId: s.userId,
      via: 'x',
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  await page.context().addCookies([{ name: 'raid_session', value: cookie, url: baseURL }]);
  await page.goto('/evaluator/practice');
  await expect(page.getByText(/No current assignments/)).toBeVisible();
  expect(await page.content()).not.toContain(f.assignment.id);
  const response = await page.request.get(
    '/api/v1/practice/reviews?evaluatorAccountId=' + f.evaluatorId,
  );
  expect(response.status()).toBe(422);
  expect(await response.text()).not.toContain(f.assignment.id);
});
