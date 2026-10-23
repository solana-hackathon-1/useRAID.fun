import { test, expect } from '@playwright/test';
import {
  seedPracticeAssignmentManagementFixture,
  db,
} from '../helpers/practice-assignment-management-browser-fixture';
const baseURL = process.env.ASSIGNMENT_MANAGEMENT_BROWSER_URL!;
test.afterAll(() => db.$disconnect());
test('writeoff host retains current private inspection and disables both new appointment actions', async ({
  page,
}) => {
  const f = await seedPracticeAssignmentManagementFixture();
  await page.context().addCookies([{ name: 'raid_session', value: f.managerCookie, url: baseURL }]);
  await page.goto(f.path);
  await expect(page.getByText(/New appointment changes are disabled/)).toBeVisible();
  await expect(page.getByText(f.assignment.reason, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Issue appointment', exact: true })).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Revoke appointment', exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Refresh current appointments' })).toBeEnabled();
  await page.getByRole('button', { name: 'Refresh current appointments' }).click();
  await expect(page.getByText(f.assignment.reason, { exact: true })).toBeVisible();
  const response = await page.request.get(
    '/api/v1/admin/practice/review-assignments?submissionId=' + f.assignment.submissionId,
  );
  expect(response.status()).toBe(200);
  expect((await response.json()).writesAvailable).toBe(false);
  expect(await page.locator('body').evaluate((e) => e.scrollWidth <= window.innerWidth)).toBe(true);
});
