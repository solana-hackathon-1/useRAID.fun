# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: practice-review-inbox.spec.ts >> own current inbox has minimal metadata and keyboard links to actual scoped original case and finding form
- Location: tests/browser-practice-review-inbox/practice-review-inbox.spec.ts:5:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('heading', { name: 'Ownership review', exact: true })
Expected: visible
Error: strict mode violation: getByRole('heading', { name: 'Ownership review', exact: true }) resolved to 2 elements:
    1) <h1>Ownership review</h1> aka locator('h1')
    2) <h2>Ownership review</h2> aka getByRole('region', { name: 'Review scope' }).getByRole('heading', { name: 'Ownership review' })

Call log:
  - Expect "toBeVisible" getByRole('heading', { name: 'Ownership review', exact: true }) with timeout 5000ms
  - waiting for getByRole('heading', { name: 'Ownership review', exact: true })

```

# Test source

```ts
  1   | import { test, expect } from '@playwright/test';
  2   | import { seedPracticeReviewInboxFixture, db } from '../helpers/practice-review-inbox-fixture';
  3   | const baseURL = process.env.PRACTICE_REVIEW_INBOX_BROWSER_URL || 'http://127.0.0.1:3032';
  4   | test.afterAll(() => db.$disconnect());
  5   | test('own current inbox has minimal metadata and keyboard links to actual scoped original case and finding form', async ({
  6   |   page,
  7   | }, info) => {
  8   |   const f = await seedPracticeReviewInboxFixture();
  9   |   await page.context().addCookies([{ name: 'raid_session', value: f.cookie, url: baseURL }]);
  10  |   const response = await page.goto('/evaluator/practice');
  11  |   await expect(page.getByRole('heading', { name: 'Your practice reviews' })).toBeVisible();
  12  |   await expect(page.getByRole('heading', { name: 'Ownership review', exact: true })).toBeVisible();
  13  |   await expect(page.getByRole('heading', { name: 'Skill assessment', exact: true })).toBeVisible();
  14  |   expect(await page.content()).not.toMatch(
  15  |     /review-private-answer-marker|review-private-explanation-marker|Synthetic inbox appointment only/,
  16  |   );
  17  |   expect(await page.locator('meta[name="robots"]').getAttribute('content')).toContain('noindex');
  18  |   if (process.env.PRACTICE_REVIEW_INBOX_SERVER_MODE === 'production') {
  19  |     expect(response?.headers()['cache-control']).toContain('private');
  20  |     expect(response?.headers()['cache-control']).toContain('no-store');
  21  |   }
  22  |   expect(
  23  |     await db.auditEvent.count({
  24  |       where: { actorId: f.evaluatorId, eventType: 'skill.practice_review_access_authorized.v1' },
  25  |     }),
  26  |   ).toBe(0);
  27  |   expect(await page.locator('body').evaluate((e) => e.scrollWidth <= window.innerWidth)).toBe(true);
  28  |   const api = await page.request.get('/api/v1/practice/reviews');
  29  |   expect(api.status()).toBe(200);
  30  |   expect(api.headers()['cache-control']).toBe('private, no-store');
  31  |   expect(api.headers()['vary']).toContain('Cookie');
  32  |   const body = await api.json();
  33  |   expect(body.entries).toHaveLength(2);
  34  |   expect(JSON.stringify(body)).not.toMatch(/accountId|answer|reason|definition|rubric/);
  35  |   const head = await page.request.head('/api/v1/practice/reviews');
  36  |   expect(head.status()).toBe(200);
  37  |   expect(await head.text()).toBe('');
  38  |   await page.screenshot({ path: info.outputPath('inbox.png'), fullPage: true });
  39  |   const own = page
  40  |     .getByRole('listitem')
  41  |     .filter({ has: page.getByRole('heading', { name: 'Ownership review', exact: true }) });
  42  |   await own.getByRole('link', { name: 'Read original case' }).focus();
  43  |   await page.keyboard.press('Enter');
  44  |   await expect(
  45  |     page.getByRole('heading', { name: 'Original submission', exact: true }),
  46  |   ).toBeVisible();
  47  |   await page.goto('/evaluator/practice');
  48  |   await page.getByRole('link', { name: 'Review ownership', exact: true }).click();
> 49  |   await expect(page.getByRole('heading', { name: 'Ownership review', exact: true })).toBeVisible();
      |                                                                                      ^ Error: expect(locator).toBeVisible() failed
  50  |   await expect(page.getByText(/review-private-explanation-marker/)).toBeVisible();
  51  | });
  52  | test('pagination retains current own ordering and refresh returns to first page', async ({
  53  |   page,
  54  | }) => {
  55  |   const f = await seedPracticeReviewInboxFixture(23);
  56  |   await page.context().addCookies([{ name: 'raid_session', value: f.cookie, url: baseURL }]);
  57  |   await page.goto('/evaluator/practice');
  58  |   await expect(page.getByRole('listitem')).toHaveCount(20);
  59  |   const ids = await page.getByRole('listitem').locator('code').allTextContents();
  60  |   await page.getByRole('link', { name: 'More assignments' }).click();
  61  |   await expect(page.getByRole('listitem')).toHaveCount(3);
  62  |   const rest = await page.getByRole('listitem').locator('code').allTextContents();
  63  |   expect(new Set([...ids, ...rest]).size).toBe(23);
  64  |   expect([...ids, ...rest]).toEqual([...ids, ...rest].sort());
  65  |   await page.getByRole('button', { name: 'Refresh assignments' }).focus();
  66  |   await page.keyboard.press('Enter');
  67  |   await expect(page.getByRole('listitem')).toHaveCount(20);
  68  |   expect(new URL(page.url()).search).toBe('');
  69  | });
  70  | test('revocation and signout remove current metadata on refresh; visitor API is private401', async ({
  71  |   page,
  72  | }) => {
  73  |   const f = await seedPracticeReviewInboxFixture(1);
  74  |   await page.context().addCookies([{ name: 'raid_session', value: f.cookie, url: baseURL }]);
  75  |   await page.goto('/evaluator/practice');
  76  |   await expect(page.getByRole('listitem')).toHaveCount(1);
  77  |   await f.revoke();
  78  |   await page.getByRole('button', { name: 'Refresh assignments' }).click();
  79  |   await expect(page.getByText(/No current assignments/)).toBeVisible();
  80  |   expect(await page.content()).not.toContain(f.assignment.id);
  81  |   await f.signOut();
  82  |   await page.getByRole('button', { name: 'Refresh assignments' }).click();
  83  |   await expect(page.getByText(/Sign in to view your current/)).toBeVisible();
  84  |   expect(await page.content()).not.toContain(f.assignment.id);
  85  |   const response = await page.request.get('/api/v1/practice/reviews?evaluatorAccountId=foreign');
  86  |   expect(response.status()).toBe(401);
  87  |   expect(response.headers()['cache-control']).toBe('private, no-store');
  88  | });
  89  | test('current administrator has no evaluator assignments; actor query cannot select another inbox', async ({
  90  |   page,
  91  | }) => {
  92  |   const f = await seedPracticeReviewInboxFixture();
  93  |   const s = await db.session.findFirstOrThrow({ where: { via: 'x' } });
  94  |   const { hash } = await import('../../src/lib/auth-primitives');
  95  |   const cookie = 'synthetic-inbox-admin-cookie';
  96  |   await db.session.create({
  97  |     data: {
  98  |       tokenHash: hash(cookie),
  99  |       userId: s.userId,
  100 |       via: 'x',
  101 |       expiresAt: new Date(Date.now() + 60000),
  102 |     },
  103 |   });
  104 |   await page.context().addCookies([{ name: 'raid_session', value: cookie, url: baseURL }]);
  105 |   await page.goto('/evaluator/practice');
  106 |   await expect(page.getByText(/No current assignments/)).toBeVisible();
  107 |   expect(await page.content()).not.toContain(f.assignment.id);
  108 |   const response = await page.request.get(
  109 |     '/api/v1/practice/reviews?evaluatorAccountId=' + f.evaluatorId,
  110 |   );
  111 |   expect(response.status()).toBe(422);
  112 |   expect(await response.text()).not.toContain(f.assignment.id);
  113 | });
  114 | 
```