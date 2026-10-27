import { test, expect, type Page, type Browser } from '@playwright/test';
import { seedWorkCreationFixture } from '../helpers/work-creation-fixture';

const baseURL = process.env.WORK_CREATION_BROWSER_URL || 'http://127.0.0.1:3041';
let fixture: Awaited<ReturnType<typeof seedWorkCreationFixture>>;
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
const step = (page: Page, n: number, name: string) =>
  page.getByRole('button', { name: `${n}. ${name}` });
// The framework's own route announcer is also an alert; scope to the wizard's messages.
const alerts = (page: Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');
const next = (page: Page) => page.getByRole('button', { name: 'Continue', exact: true }).click();

async function ready(page: Page) {
  await page.goto('/creator/work/new');
  await expect(page.getByRole('heading', { name: 'Create a Raid', level: 1 })).toBeVisible();
  // Controls are enabled only once the page is interactive.
  await expect(page.getByLabel('Title', { exact: true })).toBeEnabled();
}
async function fillOutcomeAndAcceptance(page: Page) {
  await page.getByLabel('Title', { exact: true }).fill('Write a setup guide');
  await page.getByLabel('Safe public summary').fill('A verified setup guide.');
  await page.getByLabel('Category', { exact: true }).fill('documentation');
  await page
    .getByLabel('What needs to exist or change?')
    .fill('A guide a new contributor can follow.');
  await next(page);
  await page.getByLabel('Deliverables (one per line)').fill('setup.md at a pinned commit');
  await page
    .getByLabel('Acceptance criteria (one per line, each measurable)')
    .fill('A clean installation completes using the documented steps.');
}
async function fillFormat(page: Page) {
  await step(page, 4, 'Format').click();
  await page.getByLabel('Skill 1 id').fill('writing');
}
async function fillRewardAndReview(page: Page, asset = 'Synthetic SOL', amount = '1.5') {
  await step(page, 5, 'Reward and terms').click();
  await page.getByRole('button', { name: 'Add a reward asset' }).click();
  await page.getByLabel('Reward 1 asset').selectOption({ label: asset });
  await page.getByLabel('Reward 1 amount').fill(amount);
  await page.getByLabel('Independent reviewer account').fill('synthetic-reviewer');
}
const rows = (page: Page) => fixture.db.raidSlot.count();

test('a Founder completes the guided flow by keyboard-reachable steps, reviews the reward and publishes', async ({
  browser,
}, info) => {
  fixture = await seedWorkCreationFixture();
  const page = await open(browser, fixture.founder.cookie);
  const { errors, hydration } = watch(page);
  await ready(page);
  await expect(page.getByText('Step 1 of 6: Outcome')).toBeVisible();
  await fillOutcomeAndAcceptance(page);
  await fillFormat(page);
  // Optional, clearly labelled advice that never fills in terms on its own.
  await step(page, 3, 'Recommendation').click();
  await page.getByLabel(/Reward asset \(optional/).selectOption({ label: 'Synthetic SOL' });
  await page.getByRole('button', { name: 'Get estimate' }).click();
  await expect(page.getByRole('heading', { name: 'Estimate (advice only)' })).toBeVisible();
  await expect(page.getByText(/unevaluated example/)).toBeVisible();
  await expect(page.getByText(/no price is implied/)).toBeVisible();
  await page.getByRole('button', { name: 'Use suggested difficulty and skills' }).click();
  await fillRewardAndReview(page);
  await step(page, 6, 'Review and publish').click();
  await page.getByRole('button', { name: 'Save draft' }).click();
  const review = page.getByRole('region', { name: 'Reward review' });
  await expect(review.getByRole('cell', { name: 'Synthetic SOL' })).toBeVisible();
  await expect(review.getByRole('cell', { name: '1.5', exact: true })).toBeVisible();
  await expect(review.getByText('Covered (simulated)')).toBeVisible();
  await expect(review.getByText(/Fees: 0 paid by the founder/)).toBeVisible();
  await expect(review.getByText(/No on-chain account rent/)).toBeVisible();
  expect(await rows(page)).toBe(0);
  await review.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText(/Published\. The reward is reserved \(simulated\)/)).toBeVisible();
  expect(await rows(page)).toBe(1);
  expect(
    await page.evaluate(() =>
      Object.keys(sessionStorage).filter((key) => key.startsWith('raid-wizard-')),
    ),
  ).toEqual([]);
  expect(await fixture.db.workSimulatedReservation.count()).toBe(1);
  expect(await noOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
  expect(hydration).toEqual([]);
  await page.screenshot({ path: info.outputPath('published.png'), fullPage: true });
});

test('a reward that promises two assets but is covered for one is not publishable', async ({
  browser,
}) => {
  fixture = await seedWorkCreationFixture();
  const page = await open(browser, fixture.founder.cookie);
  await ready(page);
  await fillOutcomeAndAcceptance(page);
  await fillFormat(page);
  await fillRewardAndReview(page);
  await page.getByRole('button', { name: 'Add a reward asset' }).click();
  await page
    .getByLabel('Reward 2 asset')
    .selectOption({ label: 'Synthetic token (not covered by the simulated reserve)' });
  await page.getByLabel('Reward 2 amount').fill('2.5');
  await step(page, 6, 'Review and publish').click();
  await page.getByRole('button', { name: 'Save draft' }).click();
  const review = page.getByRole('region', { name: 'Reward review' });
  await expect(review.getByText('Not covered', { exact: true })).toBeVisible();
  await expect(review.getByText(/Not every reward asset is covered/)).toBeVisible();
  await expect(review.getByRole('button', { name: 'Publish' })).toBeDisabled();
  expect(await rows(page)).toBe(0);
  // Removing the uncovered leg and saving makes the draft publishable; nothing was lost meanwhile.
  await step(page, 5, 'Reward and terms').click();
  await page.getByRole('button', { name: 'Remove reward 2' }).click();
  await step(page, 6, 'Review and publish').click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(
    page.getByRole('region', { name: 'Reward review' }).getByRole('button', { name: 'Publish' }),
  ).toBeEnabled();
  expect(await fixture.db.workListing.count()).toBe(1);
});

test('an unconfirmed save is retried with the same request key and creates one draft; the form survives a reload', async ({
  browser,
}) => {
  fixture = await seedWorkCreationFixture();
  const page = await open(browser, fixture.founder.cookie);
  await ready(page);
  await page.getByLabel('Title', { exact: true }).fill('Kept across reload');
  await page.reload();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Kept across reload');
  await page.getByLabel('Title', { exact: true }).fill('Write a setup guide');
  await page.getByLabel('Safe public summary').fill('A verified setup guide.');
  await page.getByLabel('Category', { exact: true }).fill('documentation');
  await page
    .getByLabel('What needs to exist or change?')
    .fill('A guide a new contributor can follow.');
  await next(page);
  await page.getByLabel('Deliverables (one per line)').fill('setup.md at a pinned commit');
  await page
    .getByLabel('Acceptance criteria (one per line, each measurable)')
    .fill('A clean installation completes using the documented steps.');
  await fillFormat(page);
  await fillRewardAndReview(page);
  await step(page, 6, 'Review and publish').click();
  const keys: (string | undefined)[] = [];
  let failed = false;
  await page.route('**/api/v1/work/drafts', async (route) => {
    keys.push(route.request().headers()['idempotency-key']);
    if (!failed) {
      failed = true;
      await route.abort('failed');
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(alerts(page)).toContainText('Retry with the same request');
  expect(await fixture.db.workListing.count()).toBe(0);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('region', { name: 'Reward review' })).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
  expect(await fixture.db.workListing.count()).toBe(1);
  // Reload resumes the saved draft from the server.
  await page.reload();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Write a setup guide');
});

test('invalid fields are named with a path back to the step and nothing leaves the browser', async ({
  browser,
}) => {
  fixture = await seedWorkCreationFixture();
  const page = await open(browser, fixture.founder.cookie);
  await ready(page);
  let posted = 0;
  page.on('request', (r) => r.method() === 'POST' && /\/work\/drafts$/.test(r.url()) && posted++);
  await step(page, 6, 'Review and publish').click();
  await page.getByRole('button', { name: 'Save draft' }).click();
  const alert = alerts(page);
  await expect(alert).toContainText('Title');
  await expect(alert).toContainText('Acceptance criteria');
  await expect(alert).toContainText('Reward');
  expect(posted).toBe(0);
  await alert.getByRole('button', { name: 'Go to step 1' }).first().click();
  await expect(page.getByText('Step 1 of 6: Outcome')).toBeVisible();
});

test('private drafts are not shown to other accounts, signed-out visitors or the API', async ({
  browser,
}) => {
  fixture = await seedWorkCreationFixture();
  const founder = await open(browser, fixture.founder.cookie);
  await ready(founder);
  await founder.getByLabel('Title', { exact: true }).fill('PRIVATE-DRAFT-TITLE');
  const stranger = await open(browser, fixture.stranger.cookie);
  const out = await open(browser);
  await out.goto('/creator/work/new');
  await expect(out.getByRole('link', { name: 'Sign in' })).toBeVisible();
  expect(await out.content()).not.toContain('PRIVATE-DRAFT-TITLE');
  expect((await out.request.get('/api/v1/work/creation')).status()).toBe(401);
  // A non-operator account can open the form but cannot save: the server decides authority.
  await ready(stranger);
  await stranger.getByLabel('Title', { exact: true }).fill('Write a setup guide');
  await stranger.getByLabel('Safe public summary').fill('A verified setup guide.');
  await stranger.getByLabel('Category', { exact: true }).fill('documentation');
  await stranger
    .getByLabel('What needs to exist or change?')
    .fill('A guide a new contributor can follow.');
  await next(stranger);
  await stranger.getByLabel('Deliverables (one per line)').fill('setup.md');
  await stranger
    .getByLabel('Acceptance criteria (one per line, each measurable)')
    .fill('A clean installation completes.');
  await fillFormat(stranger);
  await fillRewardAndReview(stranger);
  await step(stranger, 6, 'Review and publish').click();
  await stranger.getByRole('button', { name: 'Save draft' }).click();
  await expect(alerts(stranger)).toContainText('not permitted');
  expect(await fixture.db.workListing.count()).toBe(0);
  const state = await stranger.request.get('/api/v1/work/creation');
  expect((await state.json()).drafts).toEqual([]);
});

test('the account menu offers only the pages whose own feature is on', async ({ browser }) => {
  fixture = await seedWorkCreationFixture();
  const page = await open(browser, fixture.founder.cookie);
  await page.goto('/creator');
  await page.locator('.studio-account-trigger').click();
  const menu = page.locator('#studio-account-dropdown');
  await expect(menu.getByRole('link', { name: 'Create a Raid (guided)' })).toHaveAttribute(
    'href',
    '/creator/work/new',
  );
  for (const label of ['My Raid', 'Notifications'])
    await expect(menu.getByRole('link', { name: label })).toHaveCount(0);
});

for (const reload of [false, true]) {
  test(`reconciles a committed but unconfirmed first save before edited intent${reload ? ' after reload' : ''}`, async ({
    browser,
  }) => {
    fixture = await seedWorkCreationFixture();
    const page = await open(browser, fixture.founder.cookie);
    await ready(page);
    await fillOutcomeAndAcceptance(page);
    await fillFormat(page);
    await fillRewardAndReview(page);
    await step(page, 6, 'Review and publish').click();
    const requests: {
      key: string | undefined;
      input: { listingId: string | null; terms: { title: string } };
    }[] = [];
    let lost = false;
    await page.route('**/api/v1/work/drafts', async (route) => {
      requests.push({
        key: route.request().headers()['idempotency-key'],
        input: route.request().postDataJSON(),
      });
      if (!lost) {
        lost = true;
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        await route.abort('failed');
      } else await route.continue();
    });
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(alerts(page)).toContainText('Retry with the same request');
    expect(await fixture.db.workListing.count()).toBe(1);
    await step(page, 1, 'Outcome').click();
    await page.getByLabel('Title', { exact: true }).fill('Edited after an unknown save');
    if (reload) {
      await page.reload();
      await expect(page.getByLabel('Title', { exact: true })).toHaveValue(
        'Edited after an unknown save',
      );
    }
    await step(page, 6, 'Review and publish').click();
    await page.getByRole('button', { name: /Save (draft|changes)/ }).click();
    await expect(page.getByRole('region', { name: 'Reward review' })).toBeVisible();
    expect(await fixture.db.workListing.count()).toBe(1);
    expect(await fixture.db.termsVersion.count()).toBe(2);
    expect(requests).toHaveLength(3);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[2].input.listingId).toBeTruthy();
    expect(requests[2].input.terms.title).toBe('Edited after an unknown save');
    expect(requests[2].key).not.toBe(requests[0].key);
    expect(await noOverflow(page)).toBe(true);
  });
}
test('validates account-scoped recovery and hides unsaved text after account changes', async ({
  browser,
}) => {
  fixture = await seedWorkCreationFixture();
  const page = await open(browser, fixture.founder.cookie);
  const observed = watch(page);
  await ready(page);
  await page.evaluate((accountId) => {
    const invalid = JSON.stringify({ title: 'MALFORMED', skills: null, rewards: null, days: null });
    sessionStorage.setItem('raid-wizard-form-v1', invalid);
    sessionStorage.setItem('raid-wizard-recovery-v1:' + encodeURIComponent(accountId), invalid);
  }, fixture.founder.id);
  await page.reload();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('');
  expect(observed.errors).toEqual([]);
  await page.getByLabel('Title', { exact: true }).fill('PRIVATE-UNSAVED-ACCOUNT-TEXT');
  await page.context().clearCookies();
  await page
    .context()
    .addCookies([{ name: 'raid_session', value: fixture.stranger.cookie, url: baseURL }]);
  await ready(page);
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('');
  expect(await page.content()).not.toContain('PRIVATE-UNSAVED-ACCOUNT-TEXT');
});

test('clears only wizard recovery after successful sign-out', async ({ browser }) => {
  fixture = await seedWorkCreationFixture();
  const page = await open(browser, fixture.founder.cookie);
  await ready(page);
  await page.getByLabel('Title', { exact: true }).fill('PRIVATE-SIGNOUT-FORM');
  await page.evaluate(() => sessionStorage.setItem('unrelated-setting', 'preserved'));
  await page.getByRole('button', { name: /@founder-synthetic/ }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/creator$/);
  expect(
    await page.evaluate(() =>
      Object.keys(sessionStorage).filter((key) => key.startsWith('raid-wizard-')),
    ),
  ).toEqual([]);
  expect(await page.evaluate(() => sessionStorage.getItem('unrelated-setting'))).toBe('preserved');
});
