# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: own-assessments.spec.ts >> self-reported claim wording never denies a separate actual assessment
- Location: tests/browser-own-assessments/own-assessments.spec.ts:81:1

# Error details

```
Error: expect(locator).toHaveCount(expected) failed

Locator:  getByText('Self-reported; skill has not been assessed.', { exact: true })
Expected: 0
Received: 1
Timeout:  5000ms

Call log:
  - Expect "toHaveCount" getByText('Self-reported; skill has not been assessed.', { exact: true }) with timeout 5000ms
  - waiting for getByText('Self-reported; skill has not been assessed.', { exact: true })
    13 × locator resolved to 1 element
       - unexpected value "1"

```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | import { seedOwnAssessmentFixture, db } from '../helpers/own-assessment-fixture';
  3  | const baseURL = process.env.OWN_ASSESSMENT_BROWSER_URL || 'http://127.0.0.1:3025';
  4  | let fixture: Awaited<ReturnType<typeof seedOwnAssessmentFixture>>;
  5  | test.beforeEach(async ({ page }) => {
  6  |   fixture = await seedOwnAssessmentFixture();
  7  |   await page.context().addCookies([{ name: 'raid_session', value: fixture.cookie, url: baseURL }]);
  8  | });
  9  | test.afterAll(() => db.$disconnect());
  10 | test('owner sees actual current assessment and refreshes after real recheck and revocation', async ({
  11 |   page,
  12 | }, info) => {
  13 |   const errors: string[] = [];
  14 |   page.on('pageerror', (e) => errors.push(e.message));
  15 |   const response = await page.goto('/raider/skills/frontend');
  16 |   expect(response?.status()).toBe(200);
  17 |   expect(response?.headers()['cache-control']).toContain('no-store');
  18 |   const panel = page.getByRole('region', { name: 'Assessment', exact: true });
  19 |   await expect(panel.getByRole('heading', { name: 'Assessment', exact: true })).toBeVisible();
  20 |   await expect(panel.getByText('Verified', { exact: true })).toBeVisible();
  21 |   await expect(panel.getByText('Assessed rank: A', { exact: true })).toBeVisible();
  22 |   const api = await page.request.get('/api/v1/skill-assessments/frontend');
  23 |   expect(api.status()).toBe(200);
  24 |   expect(api.headers()['cache-control']).toBe('private, no-store');
  25 |   expect(api.headers()['vary']).toContain('Cookie');
  26 |   const body = JSON.stringify(await api.json());
  27 |   for (const key of [
  28 |     'answer',
  29 |     'explanation',
  30 |     'findings',
  31 |     'confidenceStatement',
  32 |     'evaluatorAccountId',
  33 |     'sessionHash',
  34 |   ])
  35 |     expect(body).not.toContain('"' + key + '"');
  36 |   await fixture.decide('REQUIRE_REASSESSMENT');
  37 |   await panel.getByRole('button', { name: 'Refresh assessment', exact: true }).click();
  38 |   await expect(panel.getByText('Reassessment required', { exact: true })).toBeVisible();
  39 |   await expect(panel.getByText('Verified', { exact: true })).toHaveCount(0);
  40 |   await fixture.decide('REVOKE');
  41 |   await panel.getByRole('button', { name: 'Refresh assessment', exact: true }).focus();
  42 |   await page.keyboard.press('Enter');
  43 |   await expect(panel.getByText('Verification revoked', { exact: true })).toBeVisible();
  44 |   await page.reload();
  45 |   await expect(panel.getByText('Verification revoked', { exact: true })).toBeVisible();
  46 |   expect(await page.locator('body').evaluate((e) => e.scrollWidth <= window.innerWidth)).toBe(true);
  47 |   expect(errors).toEqual([]);
  48 |   await page.screenshot({ path: info.outputPath('current-assessment.png'), fullPage: true });
  49 | });
  50 | test('refresh authority failure clears an old private verification status', async ({ page }) => {
  51 |   await page.goto('/raider/skills/frontend');
  52 |   const panel = page.getByRole('region', { name: 'Assessment', exact: true });
  53 |   await expect(panel.getByText('Verified', { exact: true })).toBeVisible();
  54 |   await db.session.deleteMany({ where: { tokenHash: fixture.cookieHash } });
  55 |   await panel.getByRole('button', { name: 'Refresh assessment', exact: true }).click();
  56 |   await expect(panel.getByRole('alert')).toContainText('Sign in');
  57 |   await expect(panel.getByText('Verified', { exact: true })).toHaveCount(0);
  58 |   await expect(panel.getByText('Assessed rank: A', { exact: true })).toHaveCount(0);
  59 | });
  60 | test('not-yet-assessed and temporary unavailable states never display a fabricated verified rank', async ({
  61 |   page,
  62 | }) => {
  63 |   fixture = await seedOwnAssessmentFixture(false);
  64 |   await page.context().clearCookies();
  65 |   await page.context().addCookies([{ name: 'raid_session', value: fixture.cookie, url: baseURL }]);
  66 |   await page.goto('/raider/skills/frontend');
  67 |   const panel = page.getByRole('region', { name: 'Assessment', exact: true });
  68 |   await expect(panel.getByText('Not yet assessed', { exact: true })).toBeVisible();
  69 |   await page.route('**/api/v1/skill-assessments/frontend', (route) =>
  70 |     route.fulfill({
  71 |       status: 503,
  72 |       contentType: 'application/json',
  73 |       body: '{"error":{"code":"SERVICE_UNAVAILABLE"}}',
  74 |     }),
  75 |   );
  76 |   await panel.getByRole('button', { name: 'Refresh assessment', exact: true }).click();
  77 |   await expect(panel.getByRole('alert')).toContainText('unavailable');
  78 |   await expect(panel.getByText('Verified', { exact: true })).toHaveCount(0);
  79 | });
  80 |
  81 | test('self-reported claim wording never denies a separate actual assessment', async ({ page }) => {
  82 |   await page.goto('/raider/skills/frontend');
  83 |   await expect(
  84 |     page.getByText('Self-reported; skill has not been assessed.', { exact: true }),
> 85 |   ).toHaveCount(0);
     |     ^ Error: expect(locator).toHaveCount(expected) failed
  86 |   await expect(
  87 |     page.getByText('Self-reported claim; this claim does not verify a rank.', { exact: true }),
  88 |   ).toBeVisible();
  89 | });
  90 |
```
