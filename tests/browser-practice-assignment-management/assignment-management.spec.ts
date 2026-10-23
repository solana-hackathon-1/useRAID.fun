import { test, expect, type Page } from '@playwright/test';
import {
  seedPracticeAssignmentManagementFixture,
  db,
} from '../helpers/practice-assignment-management-browser-fixture';
const baseURL = process.env.ASSIGNMENT_MANAGEMENT_BROWSER_URL || 'http://127.0.0.1:3036';
const endpoint = '/api/v1/admin/practice/review-assignments';
test.afterAll(() => db.$disconnect());
async function fillIssue(page: Page, evaluatorId: string, reason: string) {
  await expect(page.getByLabel('Evaluator account ID', { exact: true })).toBeEnabled();
  await page.getByLabel('Evaluator account ID', { exact: true }).fill(evaluatorId);
  await page.getByLabel('Review purpose', { exact: true }).selectOption('ASSESSMENT_REVIEW');
  await page
    .getByLabel('Expiry (UTC)', { exact: true })
    .fill(new Date(Date.now() + 3600000).toISOString().slice(0, 16));
  await page.getByLabel('Appointment reason', { exact: true }).fill(reason);
}
test('missing revoke target retains observed history until refresh, then permits another command', async ({
  page,
}, info) => {
  const f = await seedPracticeAssignmentManagementFixture();
  await page.context().addCookies([{ name: 'raid_session', value: f.managerCookie, url: baseURL }]);
  await page.goto(f.path);
  await expect(page.getByText(f.assignment.reason, { exact: true })).toBeVisible();
  await page.route('**/api/v1/admin/practice/review-assignments/*/revocations', (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }),
  );
  await page.getByLabel('Appointment to revoke', { exact: true }).selectOption(f.assignment.id);
  await page.getByLabel('Revocation reason', { exact: true }).fill('Synthetic missing target.');
  await page.getByRole('button', { name: 'Revoke appointment', exact: true }).click();
  await expect(page.getByText(/This appointment changed or was already revoked/)).toBeVisible();
  await expect(page.getByText(f.assignment.reason, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Issue appointment', exact: true })).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Revoke appointment', exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Retry same request', exact: true })).toHaveCount(
    0,
  );
  await page.screenshot({ path: info.outputPath('missing-revoke-stale.png'), fullPage: true });
  await page.getByRole('button', { name: 'Refresh current appointments', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Issue appointment', exact: true })).toBeEnabled();
  await fillIssue(page, f.evaluatorId, 'Synthetic command after missing target refresh.');
  await page.getByRole('button', { name: 'Issue appointment', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Saved historical receipt', exact: true }),
  ).toBeVisible();
  expect(await page.locator('body').evaluate((e) => e.scrollWidth <= window.innerWidth)).toBe(true);
});
test('current X admin issues and revokes actual finite appointments with safe private metadata and responsive keyboard UI', async ({
  page,
}, info) => {
  const f = await seedPracticeAssignmentManagementFixture();
  await page.context().addCookies([{ name: 'raid_session', value: f.managerCookie, url: baseURL }]);
  const response = await page.goto(f.path);
  await expect(
    page.getByRole('heading', { name: 'Review appointments', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Original appointment record: ISSUED. Current observation: ACTIVE.', {
      exact: true,
    }),
  ).toBeVisible();
  expect(await page.content()).not.toMatch(
    /review-private-answer-marker|review-private-explanation-marker/,
  );
  expect(await page.locator('meta[name="robots"]').getAttribute('content')).toContain('noindex');
  if (process.env.ASSIGNMENT_MANAGEMENT_SERVER_MODE === 'production') {
    expect(response?.headers()['cache-control']).toContain('private');
    expect(response?.headers()['cache-control']).toContain('no-store');
  }
  const reason = '<script>window.__manager_injected=true</script> Synthetic reason.';
  await fillIssue(page, f.evaluatorId, reason);
  await page.getByRole('button', { name: 'Issue appointment', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Saved historical receipt', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Appointments observed before save', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Refresh current appointments', exact: true }).click();
  await expect(page.getByText(reason, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, '__manager_injected'))).toBeUndefined();
  const saved = await db.practiceTrialReviewAssignment.findFirstOrThrow({
    where: { reason, issuedByAccountId: f.managerId },
  });
  expect(saved.purpose).toBe('ASSESSMENT_REVIEW');
  await page.getByLabel('Appointment to revoke', { exact: true }).selectOption(saved.id);
  await page
    .getByLabel('Revocation reason', { exact: true })
    .fill('Synthetic browser reasoned revoke.');
  await page.getByRole('button', { name: 'Revoke appointment', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Saved historical receipt', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Refresh current appointments', exact: true }).click();
  await expect(
    page.getByText('Original appointment record: ISSUED. Current observation: REVOKED.', {
      exact: true,
    }),
  ).toBeVisible();
  expect(await db.practiceTrialReviewRevocation.count({ where: { assignmentId: saved.id } })).toBe(
    1,
  );
  const api = await page.request.get(endpoint + '?submissionId=' + f.assignment.submissionId);
  expect(api.status()).toBe(200);
  expect(api.headers()['cache-control']).toBe('private, no-store');
  expect(api.headers()['vary']).toContain('Cookie');
  expect(JSON.stringify(await api.json())).not.toMatch(/managerXId|review-private-answer-marker/);
  const head = await page.request.head(endpoint + '?submissionId=' + f.assignment.submissionId);
  expect(head.status()).toBe(200);
  expect(await head.text()).toBe('');
  expect(await page.locator('body').evaluate((e) => e.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('management.png'), fullPage: true });
});
test('unknown issue and revoke outcomes keep exact action/body/key and recover original receipts after later revocation', async ({
  page,
}) => {
  const f = await seedPracticeAssignmentManagementFixture();
  await page.context().addCookies([{ name: 'raid_session', value: f.managerCookie, url: baseURL }]);
  await page.goto(f.path);
  const requests: { url: string; key: string | undefined; body: string | null }[] = [];
  let lostIssue = false,
    lostRevoke = false;
  await page.route('**/api/v1/admin/practice/review-assignments**', async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.continue();
    requests.push({
      url: request.url(),
      key: request.headers()['idempotency-key'],
      body: request.postData(),
    });
    const revoke = request.url().endsWith('/revocations');
    if ((!revoke && !lostIssue) || (revoke && !lostRevoke)) {
      if (revoke) lostRevoke = true;
      else lostIssue = true;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort('failed');
      return;
    }
    await route.continue();
  });
  await fillIssue(page, f.evaluatorId, 'Synthetic unknown issue.');
  await page.getByRole('button', { name: 'Issue appointment', exact: true }).click();
  await expect(page.getByText(/Save status is uncertain/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh current appointments' })).toBeDisabled();
  await expect(page.getByLabel('Find submission ID')).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Revoke appointment', exact: true }),
  ).toBeDisabled();
  const issued = await db.practiceTrialReviewAssignment.findFirstOrThrow({
    where: { reason: 'Synthetic unknown issue.' },
  });
  await f.revokeOutsideBrowser(issued.id);
  await page.getByRole('button', { name: 'Retry same request' }).click();
  await expect(
    page.getByRole('heading', { name: 'Saved historical receipt', exact: true }),
  ).toBeVisible();
  expect(requests[1]).toEqual(requests[0]);
  expect(
    await db.practiceTrialReviewAssignment.count({ where: { reason: 'Synthetic unknown issue.' } }),
  ).toBe(1);
  await page.getByRole('button', { name: 'Refresh current appointments' }).click();
  await page.getByLabel('Appointment to revoke').selectOption(f.assignment.id);
  await page.getByLabel('Revocation reason').fill('Synthetic uncertain revoke.');
  await page.getByRole('button', { name: 'Revoke appointment', exact: true }).click();
  await expect(page.getByText(/Save status is uncertain/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Issue appointment', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Retry same request' }).click();
  await expect(
    page.getByRole('heading', { name: 'Saved historical receipt', exact: true }),
  ).toBeVisible();
  expect(requests[3]).toEqual(requests[2]);
  expect(
    await db.practiceTrialReviewRevocation.count({ where: { assignmentId: f.assignment.id } }),
  ).toBe(1);
});
test('visitor, wallet-only evaluator and current nonallowlisted administrator never receive management metadata', async ({
  page,
}) => {
  const f = await seedPracticeAssignmentManagementFixture();
  await page.goto(f.path);
  await expect(page.getByText('Sign in with an authorized X administrator session.')).toBeVisible();
  expect(await page.content()).not.toContain(f.assignment.reason);
  const visitor = await page.request.get(endpoint);
  expect(visitor.status()).toBe(401);
  await page.context().addCookies([{ name: 'raid_session', value: f.cookie, url: baseURL }]);
  const wallet = await page.request.get(endpoint + '?submissionId=' + f.assignment.submissionId);
  expect(wallet.status()).toBe(403);
  await page.context().addCookies([{ name: 'raid_session', value: f.managerCookie, url: baseURL }]);
  await db.user.update({
    where: { id: f.managerId },
    data: { xId: 'synthetic-no-management-allowlist' },
  });
  await page.goto(f.path);
  await expect(
    page.getByText('Appointment management is unavailable for your account.'),
  ).toBeVisible();
  expect(await page.content()).not.toContain(f.assignment.reason);
});
test('known post-save authentication denial clears private context and lookup shows honest missing/empty state', async ({
  page,
}) => {
  const f = await seedPracticeAssignmentManagementFixture();
  await page.context().addCookies([{ name: 'raid_session', value: f.managerCookie, url: baseURL }]);
  await page.goto(f.path);
  await page.getByLabel('Find submission ID').fill('99999999-9999-4999-8999-999999999999');
  await page.getByRole('button', { name: 'Lookup appointments' }).click();
  await expect(page.getByText(/No appointments on this page/)).toBeVisible();
  await expect(page.getByText(f.assignment.reason, { exact: true })).toHaveCount(0);
  expect(await page.locator('main').innerText()).not.toContain(f.assignment.reason);
  await page.getByLabel('Find submission ID').fill(f.assignment.submissionId);
  await page.getByRole('button', { name: 'Lookup appointments' }).click();
  await expect(page.getByText(f.assignment.reason, { exact: true })).toBeVisible();
  await fillIssue(page, f.evaluatorId, 'Denied synthetic command.');
  await f.signOutManager();
  await page.getByRole('button', { name: 'Issue appointment', exact: true }).click();
  await expect(page.getByText(/Management access is unavailable/)).toBeVisible();
  await expect(page.getByText(f.assignment.reason, { exact: true })).toHaveCount(0);
  expect(await page.locator('main').innerText()).not.toContain(f.assignment.reason);
  expect(
    await db.practiceTrialReviewAssignment.count({
      where: { reason: 'Denied synthetic command.' },
    }),
  ).toBe(0);
});
