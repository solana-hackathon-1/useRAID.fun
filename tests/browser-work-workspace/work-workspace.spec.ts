import { test, expect, type Page, type Browser } from '@playwright/test';
import { seedWorkWorkspaceFixture, db } from '../helpers/work-workspace-fixture';
const baseURL = process.env.WORK_WORKSPACE_BROWSER_URL || 'http://127.0.0.1:3040';
let fixture: Awaited<ReturnType<typeof seedWorkWorkspaceFixture>>;
test.afterAll(() => db.$disconnect());
async function open(browser: Browser, cookie?: string) {
  const context = await browser.newContext(
    test.info().project.name === 'mobile'
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
      : {},
  );
  if (cookie) await context.addCookies([{ name: 'raid_session', value: cookie, url: baseURL }]);
  return context.newPage();
}
function watch(page: Page) {
  const errors: string[] = [],
    hydration: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && /hydrat|server rendered HTML/i.test(m.text()))
      hydration.push(m.text());
  });
  return { errors, hydration };
}
const noOverflow = (page: Page) =>
  page.locator('body').evaluate((e) => e.scrollWidth <= window.innerWidth);
const utc = (ms: number) => new Date(Date.now() + ms).toISOString().slice(0, 16);

test('member submits, gets a revision request, resubmits and sees the accepted closure with an unsettled claim', async ({
  browser,
}, info) => {
  fixture = await seedWorkWorkspaceFixture();
  const worker = await open(browser, fixture.worker.cookie);
  const reviewer = await open(browser, fixture.reviewer.cookie);
  const { errors, hydration } = watch(worker);
  const response = await worker.goto('/raider/work');
  expect(response?.status()).toBe(200);
  await expect(worker.getByRole('heading', { name: 'My Raid', level: 1 })).toBeVisible();
  const card = worker.getByRole('region', { name: 'Synthetic documentation task' });
  await expect(card.getByText('In progress')).toBeVisible();
  await expect(card.getByText(/holds your one active Raid slot/)).toBeVisible();
  // Blank submit: nothing leaves the browser.
  let posted = 0;
  worker.on('request', (r) => r.method() === 'POST' && /submissions$/.test(r.url()) && posted++);
  await card.getByRole('button', { name: 'Submit work' }).click();
  await expect(card.getByRole('alert')).toContainText('Add an explanation');
  expect(posted).toBe(0);
  await card.getByLabel('Explanation').fill('Guide written <b>and</b> verified.');
  await card.getByLabel('Artifact 1 reference').fill('synthetic://repo/setup.md');
  await card.getByLabel('Artifact 1 immutable version').fill('a'.repeat(40));
  await card.getByRole('button', { name: 'Submit work' }).click();
  await expect(worker.getByText(/Submission saved/)).toBeVisible();
  await expect(worker.getByText('Your submission is waiting for the reviewer.')).toBeVisible();
  expect(posted).toBe(1);
  await worker.reload();
  await expect(worker.getByText('Your submission is waiting for the reviewer.')).toBeVisible();
  await expect(card.getByRole('button', { name: /Submit work|Resubmit/ })).toHaveCount(0);

  // The exact reviewer requests one bounded revision.
  await reviewer.goto('/creator/work');
  const item = reviewer.getByRole('region', { name: 'Review: Synthetic documentation task' });
  await expect(item.getByText('Guide written <b>and</b> verified.')).toBeVisible();
  await item.getByLabel('Decision').selectOption('REQUEST_REVISION');
  await item.getByLabel('Result for criterion 1').selectOption('UNMET');
  await item.getByLabel('Evidence for criterion 1').fill('Step three fails.');
  await item.getByLabel('Reason').fill('Please fix step three.');
  await item.getByLabel('Revision deadline (UTC)').fill(utc(2 * 3600000));
  await item.getByRole('button', { name: 'Record decision' }).click();
  await expect(reviewer.getByText('Decision saved.')).toBeVisible();
  await expect(reviewer.getByText('No submissions are waiting for you.')).toBeVisible();

  await worker.reload();
  await expect(worker.getByText('Please fix step three.')).toBeVisible();
  await expect(worker.getByText('Step three fails.')).toBeVisible();
  await expect(worker.getByText('Submission 2 of at most 2')).toBeVisible();
  await worker.getByLabel('Explanation').fill('Fixed step three.');
  await worker.getByLabel('Artifact 1 reference').fill('synthetic://repo/setup.md');
  await worker.getByLabel('Artifact 1 immutable version').fill('b'.repeat(40));
  await worker.getByRole('button', { name: 'Submit work' }).click();
  await expect(worker.getByText(/Submission saved/)).toBeVisible();

  await reviewer.reload();
  const second = reviewer.getByRole('region', { name: 'Review: Synthetic documentation task' });
  await expect(second.getByText('Fixed step three.')).toBeVisible();
  await expect(second.getByText('0 revision requests remaining')).toBeVisible();
  await second.getByLabel('Reason').fill('Everything is met.');
  await second.getByRole('button', { name: 'Record decision' }).click();
  await expect(reviewer.getByText('Decision saved.')).toBeVisible();

  await worker.reload();
  await expect(worker.getByText('Accepted by the reviewer.')).toBeVisible();
  await expect(worker.getByText(/no longer holds your active Raid slot/)).toBeVisible();
  await expect(worker.getByText(/Reward claim: 1 \(NATIVE_SOL\)/)).toBeVisible();
  await expect(worker.getByText('unsettled')).toBeVisible();
  expect(await noOverflow(worker)).toBe(true);
  expect(await noOverflow(reviewer)).toBe(true);
  expect(errors).toEqual([]);
  expect(hydration).toEqual([]);
  await worker.screenshot({ path: info.outputPath('member-closed.png'), fullPage: true });
  await reviewer.screenshot({ path: info.outputPath('reviewer-desk.png'), fullPage: true });
});

test('a conflicting review shows a refresh path instead of a false success', async ({
  browser,
}) => {
  fixture = await seedWorkWorkspaceFixture();
  const submission = await fixture.submitOutsideBrowser();
  const reviewer = await open(browser, fixture.reviewer.cookie);
  await reviewer.goto('/creator/work');
  const item = reviewer.getByRole('region', { name: 'Review: Synthetic documentation task' });
  await item.getByLabel('Reason').fill('Looks good.');
  // The decision lands elsewhere first (another tab/device), then this stale form submits.
  await fixture.decideOutsideBrowser(submission.submission.id, 'ACCEPT');
  await item.getByRole('button', { name: 'Record decision' }).click();
  await expect(reviewer.locator('p[role="alert"]')).toContainText('changed while you were working');
  await reviewer.getByRole('button', { name: 'Refresh' }).click();
  await expect(reviewer.getByText('No submissions are waiting for you.')).toBeVisible();
});

test('founder issues and revokes an offer; the applicant sees it without an accept control', async ({
  browser,
}, info) => {
  fixture = await seedWorkWorkspaceFixture();
  const founder = await open(browser, fixture.founder.cookie);
  const applicant = await open(browser, fixture.applicant.cookie);
  const { errors, hydration } = watch(founder);
  await founder.goto('/creator/work');
  const row = founder.getByRole('group', { name: 'Applicant ' + fixture.applicationId });
  await expect(row.getByText('synthetic:portfolio')).toBeVisible();
  await row.getByLabel('Offer expires (UTC)').fill(utc(2 * 3600000));
  await row.getByRole('button', { name: 'Issue offer' }).click();
  await expect(founder.getByText(/Offer issued/)).toBeVisible();
  await expect(row.getByRole('button', { name: 'Revoke offer' })).toBeVisible();

  await applicant.goto('/raider/work');
  await expect(applicant.getByText('Offer waiting until')).toBeVisible();
  await expect(applicant.getByText(/acceptance is not offered here/)).toBeVisible();
  await expect(applicant.getByRole('button', { name: /accept/i })).toHaveCount(0);

  await row.getByRole('button', { name: 'Revoke offer' }).click();
  await expect(founder.getByText('Offer revoked.')).toBeVisible();
  await applicant.reload();
  await expect(applicant.getByText(/withdrawn by the founder/)).toBeVisible();
  await applicant.screenshot({ path: info.outputPath('applicant.png'), fullPage: true });
  expect(await noOverflow(founder)).toBe(true);
  expect(errors).toEqual([]);
  expect(hydration).toEqual([]);
});

test('applicant withdraws a nonbinding application', async ({ browser }) => {
  fixture = await seedWorkWorkspaceFixture();
  const applicant = await open(browser, fixture.applicant.cookie);
  await applicant.goto('/raider/work');
  await expect(applicant.getByText('An application is not a commitment.')).toBeVisible();
  await applicant.getByRole('button', { name: 'Withdraw application' }).click();
  await expect(applicant.getByText('Application withdrawn.', { exact: true })).toBeVisible();
  await expect(applicant.getByRole('button', { name: 'Withdraw application' })).toHaveCount(0);
});

test('signed-out and foreign access never reveal work data', async ({ browser }) => {
  fixture = await seedWorkWorkspaceFixture();
  await fixture.submitOutsideBrowser();
  const anonymous = await open(browser);
  for (const path of ['/raider/work', '/creator/work']) {
    await anonymous.goto(path);
    await expect(anonymous.getByRole('link', { name: 'Sign in' })).toBeVisible();
    await expect(anonymous.getByText('Synthetic documentation task')).toHaveCount(0);
  }
  for (const path of ['/api/v1/work/me', '/api/v1/work/reviews', '/api/v1/work/applicants']) {
    const denied = await anonymous.request.get(baseURL + path);
    expect(denied.status()).toBe(401);
  }
  const stranger = await open(browser, fixture.stranger.cookie);
  await stranger.goto('/raider/work');
  await expect(stranger.getByText('You have no accepted Raids yet')).toBeVisible();
  await expect(stranger.getByText('Synthetic documentation task')).toHaveCount(0);
  await stranger.goto('/creator/work');
  await expect(stranger.getByText('No submissions are waiting for you.')).toBeVisible();
  await expect(stranger.getByText('No applicants on listings you manage.')).toBeVisible();
  // The exact reviewer is not a member and the worker is not the reviewer.
  const worker = await open(browser, fixture.worker.cookie);
  await worker.goto('/creator/work');
  await expect(worker.getByText('No submissions are waiting for you.')).toBeVisible();
  const read = await worker.request.get(baseURL + '/api/v1/work/me');
  expect(read.status()).toBe(200);
  expect(read.headers()['cache-control']).toBe('private, no-store');
  const body = JSON.stringify(await read.json());
  expect(body).not.toContain('sessionHash');
  expect(body).not.toContain(fixture.reviewer.id);
});
