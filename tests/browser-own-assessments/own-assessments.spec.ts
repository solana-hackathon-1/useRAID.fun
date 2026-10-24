import { test, expect } from '@playwright/test';
import { seedOwnAssessmentFixture, db } from '../helpers/own-assessment-fixture';
const baseURL = process.env.OWN_ASSESSMENT_BROWSER_URL || 'http://127.0.0.1:3025';
let fixture: Awaited<ReturnType<typeof seedOwnAssessmentFixture>>;
test.beforeEach(async ({ page }) => {
  fixture = await seedOwnAssessmentFixture();
  await page.context().addCookies([{ name: 'raid_session', value: fixture.cookie, url: baseURL }]);
});
test.afterAll(() => db.$disconnect());
test('owner sees actual current assessment and refreshes after real recheck and revocation', async ({
  page,
}, info) => {
  const errors: string[] = [],
    hydrationErrors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && /hydrat|server rendered HTML/i.test(message.text()))
      hydrationErrors.push(message.text());
  });
  const response = await page.goto('/raider/skills/frontend');
  expect(response?.status()).toBe(200);
  if (process.env.OWN_ASSESSMENT_SERVER_MODE === 'production') {
    expect(response?.headers()['cache-control']).toContain('private');
    expect(response?.headers()['cache-control']).toContain('no-store');
  } else {
    // Installed Next 16.4 base-server forces this development-only policy for documents.
    expect(response?.headers()['cache-control']).toBe('no-store');
  }
  const panel = page.getByRole('region', { name: 'Assessment', exact: true });
  await expect(panel.getByRole('heading', { name: 'Assessment', exact: true })).toBeVisible();
  await expect(panel.getByText('Verified', { exact: true })).toBeVisible();
  await expect(panel.getByText('Assessed rank: A', { exact: true })).toBeVisible();
  const api = await page.request.get('/api/v1/skill-assessments/frontend');
  expect(api.status()).toBe(200);
  expect(api.headers()['cache-control']).toBe('private, no-store');
  expect(api.headers()['vary']).toContain('Cookie');
  const body = JSON.stringify(await api.json());
  for (const key of [
    'answer',
    'explanation',
    'findings',
    'confidenceStatement',
    'evaluatorAccountId',
    'sessionHash',
  ])
    expect(body).not.toContain('"' + key + '"');
  await fixture.decide('REQUIRE_REASSESSMENT');
  await panel.getByRole('button', { name: 'Refresh assessment', exact: true }).click();
  await expect(panel.getByText('Reassessment required', { exact: true })).toBeVisible();
  await expect(panel.getByText('Verified', { exact: true })).toHaveCount(0);
  await fixture.decide('REVOKE');
  await panel.getByRole('button', { name: 'Refresh assessment', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(panel.getByText('Verification revoked', { exact: true })).toBeVisible();
  await page.reload();
  await expect(panel.getByText('Verification revoked', { exact: true })).toBeVisible();
  expect(await page.locator('body').evaluate((e) => e.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByText('Loading private claim controls…', { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.screenshot({
    path: info.outputPath('current-assessment.png'),
    fullPage: true,
    caret: 'initial',
  });
  expect(hydrationErrors).toEqual([]);
});
test('refresh authority failure clears an old private verification status', async ({ page }) => {
  await page.goto('/raider/skills/frontend');
  const panel = page.getByRole('region', { name: 'Assessment', exact: true });
  await expect(panel.getByText('Verified', { exact: true })).toBeVisible();
  await db.session.deleteMany({ where: { tokenHash: fixture.cookieHash } });
  await panel.getByRole('button', { name: 'Refresh assessment', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Sign in');
  await expect(panel.getByText('Verified', { exact: true })).toHaveCount(0);
  await expect(panel.getByText('Assessed rank: A', { exact: true })).toHaveCount(0);
});
test('not-yet-assessed and temporary unavailable states never display a fabricated verified rank', async ({
  page,
}) => {
  fixture = await seedOwnAssessmentFixture(false);
  await page.context().clearCookies();
  await page.context().addCookies([{ name: 'raid_session', value: fixture.cookie, url: baseURL }]);
  await page.goto('/raider/skills/frontend');
  const panel = page.getByRole('region', { name: 'Assessment', exact: true });
  await expect(panel.getByText('Not yet assessed', { exact: true })).toBeVisible();
  await page.route('**/api/v1/skill-assessments/frontend', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"error":{"code":"SERVICE_UNAVAILABLE"}}',
    }),
  );
  await panel.getByRole('button', { name: 'Refresh assessment', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('unavailable');
  await expect(panel.getByText('Verified', { exact: true })).toHaveCount(0);
});

test('self-reported claim wording never denies a separate actual assessment', async ({ page }) => {
  await page.goto('/raider/skills/frontend');
  await expect(
    page.getByText('Self-reported; skill has not been assessed.', { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText('Self-reported claim; this claim does not verify a rank.', { exact: true }),
  ).toBeVisible();
});

test('loading is accessible and a foreign-scope response cannot replace the actual own status', async ({
  page,
}) => {
  await page.goto('/raider/skills/frontend');
  const panel = page.getByRole('region', { name: 'Assessment', exact: true });
  await expect(panel.getByText('Verified', { exact: true })).toBeVisible();
  const original = await (await page.request.get('/api/v1/skill-assessments/frontend')).json();
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  await page.route('**/api/v1/skill-assessments/frontend', async (route) => {
    await hold;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...original,
        view: {
          ...original.view,
          skillDomain: 'another-domain',
          taxonomyReference: { recordId: 'another-catalog', revision: 1 },
        },
      }),
    });
  });
  await panel.getByRole('button', { name: 'Refresh assessment', exact: true }).click();
  try {
    await expect(
      panel.getByRole('button', { name: 'Refresh assessment', exact: true }),
    ).toBeDisabled();
    await expect(panel.getByRole('status')).toHaveText('Loading assessment…');
    await expect(panel.getByText('Verified', { exact: true })).toHaveCount(0);
  } finally {
    release();
  }
  await expect(panel.getByRole('alert')).toContainText('unavailable');
  await expect(panel.getByText('Verified', { exact: true })).toHaveCount(0);
});
