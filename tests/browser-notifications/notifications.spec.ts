import { test, expect, type Page, type Browser } from '@playwright/test';
import { seedNotificationsFixture } from '../helpers/notifications-fixture';

const baseURL = process.env.NOTIFICATIONS_BROWSER_URL || 'http://127.0.0.1:3042';
let fixture: Awaited<ReturnType<typeof seedNotificationsFixture>>;
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

test('a member sees a safe acceptance notice, marks it read, and keeps the choice after reload', async ({
  browser,
}, info) => {
  fixture = await seedNotificationsFixture();
  await fixture.dispatch();
  await fixture.dispatch();
  const page = await open(browser, fixture.worker.cookie);
  const { errors, hydration } = watch(page);
  expect((await page.goto('/notifications'))?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Notifications', level: 1 })).toBeVisible();
  await expect(
    page.getByText('Your Raid was accepted. Open My Raid for the next steps.'),
  ).toBeVisible();
  await expect(page.getByText('1 unread.')).toBeVisible();
  // Nothing about the work reaches the page, and a repeated dispatch did not duplicate the notice.
  expect(await page.content()).not.toMatch(/SECRET/);
  await expect(page.getByText('Your Raid was accepted.')).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/raider/work');
  await page.getByRole('button', { name: 'Mark as read' }).click();
  await expect(page.getByText('Nothing new.')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Nothing new.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark as read' })).toHaveCount(0);
  expect(await noOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
  expect(hydration).toEqual([]);
  await page.screenshot({ path: info.outputPath('member-notifications.png'), fullPage: true });
});

test('the person controls optional promotional notices but not their own work notices', async ({
  browser,
}) => {
  fixture = await seedNotificationsFixture();
  await fixture.dispatch();
  const page = await open(browser, fixture.worker.cookie);
  await page.goto('/notifications');
  const box = page.getByLabel(/optional discovery and promotional/);
  await expect(box).toBeEnabled();
  await expect(box).not.toBeChecked();
  const saved = () => page.waitForResponse((r) => /\/notifications\/preferences$/.test(r.url()));
  await Promise.all([saved(), box.check()]);
  await expect(box).toBeChecked();
  await page.reload();
  await expect(box).toBeChecked();
  await Promise.all([saved(), box.uncheck()]);
  await page.reload();
  await expect(box).not.toBeChecked();
  await expect(page.getByText('Your Raid was accepted.')).toBeVisible();
  await expect(page.getByText(/cannot be turned off/)).toBeVisible();
});

test('each party sees only their own notices and others are isolated, including the API', async ({
  browser,
}) => {
  fixture = await seedNotificationsFixture();
  await fixture.dispatch();
  const founder = await open(browser, fixture.founder.cookie);
  await founder.goto('/notifications');
  await expect(founder.getByText('Someone accepted your Raid.')).toBeVisible();
  await expect(founder.getByText('Your Raid was accepted.')).toHaveCount(0);
  const reviewer = await open(browser, fixture.reviewer.cookie);
  await reviewer.goto('/notifications');
  await expect(reviewer.getByText('No notifications yet.')).toBeVisible();
  const stranger = await open(browser, fixture.stranger.cookie);
  await stranger.goto('/notifications');
  await expect(stranger.getByText('No notifications yet.')).toBeVisible();
  const own = await (await founder.request.get('/api/v1/notifications')).json();
  const foreign = await stranger.request.post(`/api/v1/notifications/${own.items[0].id}/read`, {
    data: {},
    headers: { origin: baseURL },
  });
  expect(foreign.status()).toBe(404);
  const out = await open(browser);
  await out.goto('/notifications');
  await expect(out.getByRole('link', { name: 'Sign in' })).toBeVisible();
  expect((await out.request.get('/api/v1/notifications')).status()).toBe(401);
});

test('the account menu offers only the pages whose own feature is on', async ({ browser }) => {
  fixture = await seedNotificationsFixture();
  const page = await open(browser, fixture.worker.cookie);
  await page.goto('/creator');
  await page.locator('.studio-account-trigger').click();
  const menu = page.locator('#studio-account-dropdown');
  await expect(menu.getByRole('link', { name: 'Notifications' })).toHaveAttribute(
    'href',
    '/notifications',
  );
  for (const label of ['My Raid', 'Create a Raid (guided)'])
    await expect(menu.getByRole('link', { name: label })).toHaveCount(0);
});
