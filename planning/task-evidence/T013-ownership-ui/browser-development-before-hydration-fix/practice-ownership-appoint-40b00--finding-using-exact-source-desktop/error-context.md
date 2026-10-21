# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: practice-ownership.spec.ts >> appointed evaluator saves, rechecks and corrects a finding using exact source
- Location: tests/browser-practice-ownership/practice-ownership.spec.ts:16:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText(/UNCONFIRMED · version 2/)
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" getByText(/UNCONFIRMED · version 2/) with timeout 5000ms
  - waiting for getByText(/UNCONFIRMED · version 2/)

```

```yaml
- link "Skip to content":
  - /url: "#main"
- banner:
  - link "useRAID.fun home":
    - /url: /
    - text: useRAID.fun
  - navigation "Main navigation":
    - link "Discover":
      - /url: /
    - link "Creator studio":
      - /url: /creator
    - link "Launchpads · Coming soon":
      - /url: /launch
    - link "How it works":
      - /url: /methodology
  - link "Create a raid":
    - /url: /creator/new
    - img
    - text: Create a raid
  - button "@synthetic-reviewer":
    - text: "@synthetic-reviewer"
    - img
- main:
  - heading "Ownership review" [level=1]
  - paragraph: This finding does not verify a rank, decide fraud guilt or grant access.
  - region "Current ownership finding":
    - heading "Current ownership finding" [level=2]
    - paragraph: CONFIRMED · version 1
    - paragraph: Synthetic ownership explanation. <img src="/ownership-inert">
    - list:
      - listitem: "EXPLANATION: Synthetic bounded explanation observation."
    - paragraph: Recorded by cmvhrg6zk0002oitkiw0f8l6z under policy synthetic-ownership-82af0b46-3792-45d1-9d7f-62e18cf2f5b3, version 1.
  - region "Approved ownership policy":
    - heading "Approved ownership policy" [level=2]
    - paragraph: Policy synthetic-ownership-82af0b46-3792-45d1-9d7f-62e18cf2f5b3, version 1.
    - paragraph: Synthetic approved ownership guidance. <script>policy-inert</script>
  - heading "Record ownership finding" [level=2]
  - group "Reasoned finding":
    - text: Reasoned finding Finding
    - combobox "Finding":
      - option "Choose a finding" [selected]
      - option "Confirm ownership"
      - option "Dispute ownership"
      - option "Request more evidence"
    - text: Reason
    - textbox "Reason": Synthetic reasoned correction.
    - text: Observation 1 type
    - combobox "Observation 1 type":
      - option "Explanation" [selected]
      - option "Modification"
      - option "Attribution"
      - option "Other"
    - text: Observation 1
    - textbox "Observation 1": Synthetic bounded explanation observation.
    - button "Add observation"
    - button "Save finding"
  - paragraph: A save uses the policy and finding versions shown here. Keep this page open if its outcome is uncertain; retry the same request.
  - button "Recheck current case"
  - region "Review scope":
    - heading "Ownership review" [level=2]
    - paragraph: Private evidence for this assigned case. Access was checked for this page and may change. Recheck before relying on it.
    - paragraph:
      - text: "Assignment expires:"
      - time: 21 Oct 2026, 07:58 UTC
      - text: .
  - region "Original submission":
    - heading "Original submission" [level=2]
    - paragraph:
      - text: "Submitted:"
      - time: 21 Oct 2026, 06:58 UTC
      - text: .
    - paragraph: "Original ownership declaration: Unconfirmed. This original submission does not include later ownership findings or assessment results."
    - heading "Answer" [level=3]
    - text: <script>window.__review_injected = true</script> <img src="/should-not-fetch-review-fixture">review-private-answer-marker
    - heading "Explanation" [level=3]
    - paragraph: review-private-explanation-marker
    - heading "Declared tools and assistance" [level=3]
    - paragraph: "Tools declared: editor."
    - paragraph: "AI assistance declared: Yes."
    - paragraph: review-private-disclosure-marker
    - paragraph: Declarations alone do not establish ownership, compliance or assessed skill.
  - region "Original review criteria":
    - heading "Original review criteria" [level=2]
    - paragraph: Synthetic interface exercise — frontend (web), practice level A.
    - list:
      - listitem:
        - strong: "Required:"
        - text: Working behavior and edge cases
      - listitem:
        - strong: "Required:"
        - text: Explain and modify the solution
    - paragraph: The authorized reviewer applies every required criterion.
    - paragraph: "Evaluation: Manual review."
    - paragraph: "Rubric: synthetic-submission-rubric, version 1."
  - group: Original task and agreed conditions
- contentinfo:
  - link "useRAID.fun":
    - /url: /
  - text: Community attention, in context.
  - link "Methodology":
    - /url: /methodology
  - link "Privacy":
    - /url: /privacy
  - link "Admin":
    - /url: /admin
    - img
    - text: Admin
- alert
```

# Test source

```ts
  1   | import { test, expect } from '@playwright/test';
  2   | import { seedPracticeOwnershipFixture, db } from '../helpers/practice-ownership-browser-fixture';
  3   | const baseURL = process.env.PRACTICE_OWNERSHIP_BROWSER_URL || 'http://127.0.0.1:3029';
  4   | test.afterAll(() => db.$disconnect());
  5   | async function fill(
  6   |   page: import('@playwright/test').Page,
  7   |   decision = 'CONFIRM',
  8   |   reason = 'Synthetic ownership explanation. <img src="/ownership-inert">',
  9   | ) {
  10  |   await page.getByLabel('Finding', { exact: true }).selectOption(decision);
  11  |   await page.getByLabel('Reason', { exact: true }).fill(reason);
  12  |   await page
  13  |     .getByLabel('Observation 1', { exact: true })
  14  |     .fill('Synthetic bounded explanation observation.');
  15  | }
  16  | test('appointed evaluator saves, rechecks and corrects a finding using exact source', async ({
  17  |   page,
  18  | }, info) => {
  19  |   const f = await seedPracticeOwnershipFixture();
  20  |   await page.context().addCookies([{ name: 'raid_session', value: f.cookie, url: baseURL }]);
  21  |   const errors: string[] = [];
  22  |   page.on('pageerror', (e) => errors.push(e.message));
  23  |   const fetched: string[] = [];
  24  |   page.on('request', (r) => {
  25  |     if (r.url().includes('ownership-inert')) fetched.push(r.url());
  26  |   });
  27  |   const response = await page.goto(f.path);
  28  |   await expect(page.getByRole('heading', { name: 'Record ownership finding' })).toBeVisible();
  29  |   if (process.env.PRACTICE_OWNERSHIP_SERVER_MODE === 'production') {
  30  |     expect(response?.headers()['cache-control']).toContain('no-store');
  31  |     expect(response?.headers()['cache-control']).toContain('private');
  32  |   }
  33  |   expect(await page.title()).not.toContain(f.definition.title);
  34  |   expect(await page.locator('meta[name=robots]').getAttribute('content')).toContain('noindex');
  35  |   await expect(page.getByText(/Synthetic approved ownership guidance/)).toBeVisible();
  36  |   await fill(page);
  37  |   await page.getByRole('button', { name: 'Save finding', exact: true }).focus();
  38  |   await page.keyboard.press('Enter');
  39  |   await expect(page.getByRole('status').filter({ hasText: 'Finding saved' })).toBeVisible();
  40  |   await expect(page.getByText(/CONFIRMED · version 1/)).toBeVisible();
  41  |   await expect(page.getByText(/Original ownership declaration: Unconfirmed/)).toBeVisible();
  42  |   await page.getByRole('button', { name: 'Recheck current case' }).click();
  43  |   await expect(page.getByRole('heading', { name: 'Record ownership finding' })).toBeVisible();
  44  |   await fill(page, 'MORE_EVIDENCE', 'Synthetic reasoned correction.');
  45  |   await page.getByRole('button', { name: 'Save finding', exact: true }).click();
> 46  |   await expect(page.getByText(/UNCONFIRMED · version 2/)).toBeVisible();
      |                                                           ^ Error: expect(locator).toBeVisible() failed
  47  |   expect(await db.practiceTrialOwnershipVersion.count()).toBe(2);
  48  |   expect(fetched).toEqual([]);
  49  |   expect(errors).toEqual([]);
  50  |   expect(await page.locator('body').evaluate((e) => e.scrollWidth <= window.innerWidth)).toBe(true);
  51  |   await page.screenshot({ path: info.outputPath('ownership-saved.png'), fullPage: true });
  52  | });
  53  | test('uncertain response retries identical command after approved policy withdrawal', async ({
  54  |   page,
  55  | }) => {
  56  |   const f = await seedPracticeOwnershipFixture();
  57  |   await page.context().addCookies([{ name: 'raid_session', value: f.cookie, url: baseURL }]);
  58  |   const requests: { key: string | undefined; body: string | null }[] = [];
  59  |   await page.route('**/api/v1/practice/reviews/**/ownership', async (route) => {
  60  |     requests.push({
  61  |       key: route.request().headers()['idempotency-key'],
  62  |       body: route.request().postData(),
  63  |     });
  64  |     const response = await route.fetch();
  65  |     if (requests.length === 1) {
  66  |       expect(response.status()).toBe(200);
  67  |       await route.abort('failed');
  68  |     } else await route.fulfill({ response });
  69  |   });
  70  |   await page.goto(f.path);
  71  |   await fill(page);
  72  |   await page.getByRole('button', { name: 'Save finding', exact: true }).click();
  73  |   await expect(page.getByText(/Save status is uncertain/)).toBeVisible();
  74  |   await expect(page.getByRole('button', { name: 'Recheck current case' })).toBeDisabled();
  75  |   await f.withdraw();
  76  |   await page.getByRole('button', { name: 'Retry same request' }).click();
  77  |   await expect(page.getByRole('status').filter({ hasText: 'Finding saved' })).toBeVisible();
  78  |   expect(requests).toHaveLength(2);
  79  |   expect(requests[1]).toEqual(requests[0]);
  80  |   expect(await db.practiceTrialOwnershipVersion.count()).toBe(1);
  81  | });
  82  | test('stale finding requires recheck and revoked access hides visible private context', async ({
  83  |   page,
  84  | }) => {
  85  |   const f = await seedPracticeOwnershipFixture();
  86  |   await page.context().addCookies([{ name: 'raid_session', value: f.cookie, url: baseURL }]);
  87  |   await page.goto(f.path);
  88  |   await fill(page);
  89  |   await f.saveOutsideBrowser();
  90  |   await page.getByRole('button', { name: 'Save finding', exact: true }).click();
  91  |   await expect(page.getByText(/The policy or finding changed/)).toBeVisible();
  92  |   await expect(page.getByRole('button', { name: 'Save finding', exact: true })).toHaveCount(0);
  93  |   await page.getByRole('button', { name: 'Recheck current case' }).click();
  94  |   await expect(page.getByText('Synthetic concurrent finding.', { exact: true })).toBeVisible();
  95  |   await fill(page);
  96  |   await f.revoke();
  97  |   await page.getByRole('button', { name: 'Save finding', exact: true }).click();
  98  |   await expect(page.getByText(/Access to this case is unavailable/)).toBeVisible();
  99  |   await expect(page.getByText(/Synthetic approved ownership guidance/)).toHaveCount(0);
  100 |   await expect(page.getByRole('heading', { name: 'Original submission' })).toHaveCount(0);
  101 | });
  102 | test('missing policy, signed-out account and wrong evaluator never offer a new finding', async ({
  103 |   page,
  104 | }) => {
  105 |   const f = await seedPracticeOwnershipFixture(false);
  106 |   const response = await page.goto(f.path);
  107 |   await expect(page.getByText('Sign in to view this assigned case.')).toBeVisible();
  108 |   expect(await response?.text()).not.toContain('review-private-answer-marker');
  109 |   await page.context().addCookies([{ name: 'raid_session', value: f.cookie, url: baseURL }]);
  110 |   await page.goto(f.path);
  111 |   await expect(page.getByText(/No approved policy/)).toBeVisible();
  112 |   await expect(page.getByRole('button', { name: 'Save finding', exact: true })).toHaveCount(0);
  113 |   await f.signOut();
  114 |   await page.reload();
  115 |   await expect(page.getByText('Sign in to view this assigned case.')).toBeVisible();
  116 |   await expect(page.getByText(/Synthetic approved ownership guidance/)).toHaveCount(0);
  117 |   const { hash } = await import('../../src/lib/auth-primitives');
  118 |   const foreignCookie = crypto.randomUUID();
  119 |   await db.session.create({
  120 |     data: {
  121 |       tokenHash: hash(foreignCookie),
  122 |       userId: f.assignment.issuedByAccountId,
  123 |       via: 'x',
  124 |       expiresAt: new Date(Date.now() + 60000),
  125 |     },
  126 |   });
  127 |   await page.context().clearCookies();
  128 |   await page.context().addCookies([{ name: 'raid_session', value: foreignCookie, url: baseURL }]);
  129 |   const foreign = await page.goto(f.path);
  130 |   await expect(page.getByRole('heading', { name: /not found/i })).toBeVisible();
  131 |   expect(await foreign?.text()).not.toContain('review-private-answer-marker');
  132 | });
  133 | 
```