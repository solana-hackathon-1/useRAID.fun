import { test, expect } from '@playwright/test';
import {
  seedPracticeReviewFixture,
  reviewAnswer,
  db,
} from '../helpers/practice-review-browser-fixture';
const baseURL = process.env.PRACTICE_REVIEW_BROWSER_URL || 'http://127.0.0.1:3028';
test.afterAll(() => db.$disconnect());
test('assigned evaluator reads exact private evidence, original rubric and keyboard rechecks', async ({
  page,
}, info) => {
  const f = await seedPracticeReviewFixture();
  await page.context().addCookies([{ name: 'raid_session', value: f.cookie, url: baseURL }]);
  const errors: string[] = [],
    hydration: string[] = [],
    fetched: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && /hydrat|server rendered/i.test(m.text())) hydration.push(m.text());
  });
  page.on('request', (r) => {
    if (r.url().includes('should-not-fetch-review-fixture')) fetched.push(r.url());
  });
  const response = await page.goto(f.path);
  await expect(
    page.getByRole('heading', { name: 'Original submission', exact: true }),
  ).toBeVisible();
  // Installed Next forces a development-only HTML cache header. Production must forbid storage.
  if (process.env.PRACTICE_REVIEW_SERVER_MODE === 'production') {
    expect(response?.headers()['cache-control']).toContain('no-store');
    expect(response?.headers()['cache-control']).toContain('private');
  } else {
    expect(response?.headers()['cache-control']).toBe('no-cache, must-revalidate');
  }
  expect(await page.title()).not.toContain(f.definition.title);
  expect(await page.locator('meta[name="robots"]').getAttribute('content')).toContain('noindex');
  await expect(page.getByRole('heading', { name: 'Ownership review', exact: true })).toBeVisible();
  await expect(page.getByText('review-private-explanation-marker', { exact: true })).toBeVisible();
  await expect(page.getByText(/Original ownership declaration: Unconfirmed/)).toBeVisible();
  for (const criterion of f.definition.rubric.criteria)
    await expect(page.getByText(criterion.description, { exact: false })).toBeVisible();
  expect(await page.locator('pre').first().textContent()).toBe(reviewAnswer.replace(/\r\n/g, '\n'));
  expect(await page.evaluate(() => Reflect.get(window, '__review_injected'))).toBeUndefined();
  expect(fetched).toEqual([]);
  const attempts = await db.auditEvent.count({
    where: { eventType: 'skill.practice_review_access_authorized.v1', actorId: f.evaluatorId },
  });
  expect(attempts).toBe(1);
  await page.getByText('Original task and agreed conditions', { exact: true }).click();
  await expect(page.getByText(/not a deadline/)).toBeVisible();
  expect(await page.locator('body').evaluate((e) => e.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Recheck access' }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Original submission', exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      db.auditEvent.count({
        where: { eventType: 'skill.practice_review_access_authorized.v1', actorId: f.evaluatorId },
      }),
    )
    .toBe(2);
  const api = await page.request.get(
    f.path.replace('/evaluator/practice/', '/api/v1/practice/reviews/'),
  );
  expect(api.status()).toBe(200);
  expect(api.headers()['cache-control']).toBe('private, no-store');
  expect(api.headers()['vary']).toContain('Cookie');
  expect((await api.json()).review.submission.answer).toBe(reviewAnswer);
  expect(errors).toEqual([]);
  expect(hydration).toEqual([]);
  await page.screenshot({ path: info.outputPath('case-evidence.png'), fullPage: true });
});
test('visitor, wrong evaluator and wrong purpose never get private HTML', async ({ page }) => {
  const f = await seedPracticeReviewFixture();
  const signedOut = await page.goto(f.path);
  await expect(page.getByText('Sign in to view this assigned case.')).toBeVisible();
  expect(await signedOut?.text()).not.toContain('review-private-answer-marker');
  await page.context().addCookies([{ name: 'raid_session', value: f.cookie, url: baseURL }]);
  const denied = await page.goto(f.path.replace('OWNERSHIP_REVIEW', 'ASSESSMENT_REVIEW'));
  await expect(page.getByRole('heading', { name: /not found/i })).toBeVisible();
  expect(await denied?.text()).not.toContain('review-private-answer-marker');
  await db.practiceTrialReviewAssignment.findUniqueOrThrow({ where: { id: f.assignment.id } });
  // A different real current account's session, without the appointment.
  const other = await db.session.findFirstOrThrow({
    where: { userId: { not: f.evaluatorId }, via: 'wallet' },
  });
  // Its raw cookie is deliberately unavailable; create a dedicated foreign current session.
  const { hash } = await import('../../src/lib/auth-primitives');
  const foreign = 'synthetic-foreign-review-cookie';
  await db.session.create({
    data: {
      tokenHash: hash(foreign),
      userId: other.userId,
      via: 'wallet',
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  await page.context().addCookies([{ name: 'raid_session', value: foreign, url: baseURL }]);
  const foreignResponse = await page.goto(f.path);
  await expect(page.getByRole('heading', { name: /not found/i })).toBeVisible();
  expect(await foreignResponse?.text()).not.toContain('review-private-answer-marker');
});
test('saved revocation and current session loss remove details on recheck', async ({ page }) => {
  let f = await seedPracticeReviewFixture({ purpose: 'ASSESSMENT_REVIEW' });
  await page.context().addCookies([{ name: 'raid_session', value: f.cookie, url: baseURL }]);
  await page.goto(f.path);
  await expect(page.getByRole('heading', { name: 'Assessment review', exact: true })).toBeVisible();
  await f.revoke();
  await page.getByRole('button', { name: 'Recheck access' }).click();
  await expect(page.getByRole('heading', { name: /not found/i })).toBeVisible();
  expect(await page.content()).not.toContain('review-private-answer-marker');
  f = await seedPracticeReviewFixture();
  await page.context().addCookies([{ name: 'raid_session', value: f.cookie, url: baseURL }]);
  await page.goto(f.path);
  await expect(
    page.getByRole('heading', { name: 'Original submission', exact: true }),
  ).toBeVisible();
  await f.signOut();
  await page.getByRole('button', { name: 'Recheck access' }).click();
  await expect(page.getByText('Sign in to view this assigned case.')).toBeVisible();
  expect(await page.content()).not.toContain('review-private-answer-marker');
});
test('expired appointments and restricted accounts fail closed', async ({ page }) => {
  let f = await seedPracticeReviewFixture({ expiresMs: 800 });
  await new Promise((resolve) => setTimeout(resolve, 900));
  await page.context().addCookies([{ name: 'raid_session', value: f.cookie, url: baseURL }]);
  await page.goto(f.path);
  await expect(page.getByRole('heading', { name: /not found/i })).toBeVisible();
  expect(await page.content()).not.toContain('review-private-answer-marker');
  f = await seedPracticeReviewFixture();
  await db.user.update({ where: { id: f.evaluatorId }, data: { suspended: true } });
  await page.context().addCookies([{ name: 'raid_session', value: f.cookie, url: baseURL }]);
  await page.goto(f.path);
  // Existing Root auth treats an already suspended account's session as signed out.
  await expect(page.getByText('Sign in to view this assigned case.')).toBeVisible();
  expect(await page.content()).not.toContain('review-private-answer-marker');
});
