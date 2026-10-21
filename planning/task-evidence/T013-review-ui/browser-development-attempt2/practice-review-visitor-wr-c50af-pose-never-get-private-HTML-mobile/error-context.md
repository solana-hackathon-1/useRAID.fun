# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: practice-review.spec.ts >> visitor, wrong evaluator and wrong purpose never get private HTML
- Location: tests/browser-practice-review/practice-review.spec.ts:63:1

# Error details

```
TypeError: Cannot read properties of undefined (reading 'findUniqueOrThrow')
```

# Test source

```ts
  1   | import { test, expect } from '@playwright/test';
  2   | import {
  3   |   seedPracticeReviewFixture,
  4   |   reviewAnswer,
  5   |   db,
  6   | } from '../helpers/practice-review-browser-fixture';
  7   | const baseURL = process.env.PRACTICE_REVIEW_BROWSER_URL || 'http://127.0.0.1:3028';
  8   | test.afterAll(() => db.$disconnect());
  9   | test('assigned evaluator reads exact private evidence, original rubric and keyboard rechecks', async ({
  10  |   page,
  11  | }, info) => {
  12  |   const f = await seedPracticeReviewFixture();
  13  |   await page.context().addCookies([{ name: 'raid_session', value: f.cookie, url: baseURL }]);
  14  |   const errors: string[] = [],
  15  |     hydration: string[] = [],
  16  |     fetched: string[] = [];
  17  |   page.on('pageerror', (e) => errors.push(e.message));
  18  |   page.on('console', (m) => {
  19  |     if (m.type() === 'error' && /hydrat|server rendered/i.test(m.text())) hydration.push(m.text());
  20  |   });
  21  |   page.on('request', (r) => {
  22  |     if (r.url().includes('should-not-fetch-review-fixture')) fetched.push(r.url());
  23  |   });
  24  |   const response = await page.goto(f.path);
  25  |   await expect(
  26  |     page.getByRole('heading', { name: 'Original submission', exact: true }),
  27  |   ).toBeVisible();
  28  |   expect(response?.headers()['cache-control']).toContain('no-store');
  29  |   expect(response?.headers()['cache-control']).toContain('private');
  30  |   expect(await page.title()).not.toContain(f.definition.title);
  31  |   expect(await page.locator('meta[name="robots"]').getAttribute('content')).toContain('noindex');
  32  |   await expect(page.getByRole('heading', { name: 'Ownership review', exact: true })).toBeVisible();
  33  |   await expect(page.getByText('review-private-explanation-marker', { exact: true })).toBeVisible();
  34  |   await expect(page.getByText(/Original ownership declaration: Unconfirmed/)).toBeVisible();
  35  |   for (const criterion of f.definition.rubric.criteria)
  36  |     await expect(page.getByText(criterion.description, { exact: false })).toBeVisible();
  37  |   expect(await page.locator('pre').first().textContent()).toBe(reviewAnswer.replace(/\r\n/g, '\n'));
  38  |   expect(await page.evaluate(() => Reflect.get(window, '__review_injected'))).toBeUndefined();
  39  |   expect(fetched).toEqual([]);
  40  |   const attempts = await db.auditEvent.count({
  41  |     where: { eventType: 'skill.practice_review_access_authorized.v1', actorId: f.evaluatorId },
  42  |   });
  43  |   expect(attempts).toBe(1);
  44  |   await page.getByText('Original task and agreed conditions', { exact: true }).click();
  45  |   await expect(page.getByText(/not a deadline/)).toBeVisible();
  46  |   expect(await page.locator('body').evaluate((e) => e.scrollWidth <= window.innerWidth)).toBe(true);
  47  |   await page.getByRole('button', { name: 'Recheck access' }).focus();
  48  |   await page.keyboard.press('Enter');
  49  |   await expect(
  50  |     page.getByRole('heading', { name: 'Original submission', exact: true }),
  51  |   ).toBeVisible();
  52  |   await expect
  53  |     .poll(() =>
  54  |       db.auditEvent.count({
  55  |         where: { eventType: 'skill.practice_review_access_authorized.v1', actorId: f.evaluatorId },
  56  |       }),
  57  |     )
  58  |     .toBe(2);
  59  |   expect(errors).toEqual([]);
  60  |   expect(hydration).toEqual([]);
  61  |   await page.screenshot({ path: info.outputPath('case-evidence.png'), fullPage: true });
  62  | });
  63  | test('visitor, wrong evaluator and wrong purpose never get private HTML', async ({ page }) => {
  64  |   const f = await seedPracticeReviewFixture();
  65  |   const signedOut = await page.goto(f.path);
  66  |   await expect(page.getByText('Sign in to view this assigned case.')).toBeVisible();
  67  |   expect(await signedOut?.text()).not.toContain('review-private-answer-marker');
  68  |   await page.context().addCookies([{ name: 'raid_session', value: f.cookie, url: baseURL }]);
  69  |   const denied = await page.goto(f.path.replace('OWNERSHIP_REVIEW', 'ASSESSMENT_REVIEW'));
  70  |   await expect(page.getByRole('heading', { name: /not found/i })).toBeVisible();
  71  |   expect(await denied?.text()).not.toContain('review-private-answer-marker');
> 72  |   await db.practiceReviewAssignment.findUniqueOrThrow({ where: { id: f.assignment.id } });
      |                                     ^ TypeError: Cannot read properties of undefined (reading 'findUniqueOrThrow')
  73  |   // A different real current account's session, without the appointment.
  74  |   const other = await db.session.findFirstOrThrow({
  75  |     where: { userId: { not: f.evaluatorId }, via: 'wallet' },
  76  |   });
  77  |   // Its raw cookie is deliberately unavailable; create a dedicated foreign current session.
  78  |   const { hash } = await import('../../src/lib/auth-primitives');
  79  |   const foreign = 'synthetic-foreign-review-cookie';
  80  |   await db.session.create({
  81  |     data: {
  82  |       tokenHash: hash(foreign),
  83  |       userId: other.userId,
  84  |       via: 'wallet',
  85  |       expiresAt: new Date(Date.now() + 60000),
  86  |     },
  87  |   });
  88  |   await page.context().addCookies([{ name: 'raid_session', value: foreign, url: baseURL }]);
  89  |   const foreignResponse = await page.goto(f.path);
  90  |   await expect(page.getByRole('heading', { name: /not found/i })).toBeVisible();
  91  |   expect(await foreignResponse?.text()).not.toContain('review-private-answer-marker');
  92  | });
  93  | test('saved revocation and current session loss remove details on recheck', async ({ page }) => {
  94  |   let f = await seedPracticeReviewFixture({ purpose: 'ASSESSMENT_REVIEW' });
  95  |   await page.context().addCookies([{ name: 'raid_session', value: f.cookie, url: baseURL }]);
  96  |   await page.goto(f.path);
  97  |   await expect(page.getByRole('heading', { name: 'Assessment review', exact: true })).toBeVisible();
  98  |   await f.revoke();
  99  |   await page.getByRole('button', { name: 'Recheck access' }).click();
  100 |   await expect(page.getByRole('heading', { name: /not found/i })).toBeVisible();
  101 |   expect(await page.content()).not.toContain('review-private-answer-marker');
  102 |   f = await seedPracticeReviewFixture();
  103 |   await page.context().addCookies([{ name: 'raid_session', value: f.cookie, url: baseURL }]);
  104 |   await page.goto(f.path);
  105 |   await expect(
  106 |     page.getByRole('heading', { name: 'Original submission', exact: true }),
  107 |   ).toBeVisible();
  108 |   await f.signOut();
  109 |   await page.getByRole('button', { name: 'Recheck access' }).click();
  110 |   await expect(page.getByText('Sign in to view this assigned case.')).toBeVisible();
  111 |   expect(await page.content()).not.toContain('review-private-answer-marker');
  112 | });
  113 | test('expired appointments and restricted accounts fail closed', async ({ page }) => {
  114 |   let f = await seedPracticeReviewFixture({ expiresMs: 800 });
  115 |   await new Promise((resolve) => setTimeout(resolve, 900));
  116 |   await page.context().addCookies([{ name: 'raid_session', value: f.cookie, url: baseURL }]);
  117 |   await page.goto(f.path);
  118 |   await expect(page.getByRole('heading', { name: /not found/i })).toBeVisible();
  119 |   expect(await page.content()).not.toContain('review-private-answer-marker');
  120 |   f = await seedPracticeReviewFixture();
  121 |   await db.user.update({ where: { id: f.evaluatorId }, data: { suspended: true } });
  122 |   await page.context().addCookies([{ name: 'raid_session', value: f.cookie, url: baseURL }]);
  123 |   await page.goto(f.path);
  124 |   await expect(page.getByText('This case is unavailable for your account.')).toBeVisible();
  125 |   expect(await page.content()).not.toContain('review-private-answer-marker');
  126 | });
  127 | 
```