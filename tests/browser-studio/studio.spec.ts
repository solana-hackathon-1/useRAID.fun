import { test, expect, type Page } from '@playwright/test';
import { watchConsole } from '../helpers/browser-console';
import { PrismaClient } from '@prisma/client';
import { assertTestDatabase } from '../helpers/db-guard';

assertTestDatabase('useraid_studio_test');
const studioDb = new PrismaClient();
test.afterAll(async () => studioDb.$disconnect());
test.beforeEach(async ({ page }) => {
  const login = await page.request.post('/api/studio/sandbox', {
    headers: { origin: 'http://localhost:3007' },
    data: { action: 'login', fixtureId: crypto.randomUUID() },
  });
  expect(login.ok()).toBe(true);
  await page.goto('/creator');
  await expect(page.getByRole('heading', { name: 'Creator Studio', exact: true })).toBeVisible();
});
test('launch, target attribution, completion, reviewed allocation and manual test payment', async ({
  page,
}, testInfo) => {
  await page.getByRole('link', { name: 'Create Raid', exact: true }).first().click();
  await page.getByRole('button', { name: /X Campaign No token needed/ }).click();
  const title = `Browser Studio ${Date.now()}`;
  await page.getByLabel('Campaign name', { exact: true }).fill(title);
  await page
    .getByLabel('X post 1', { exact: true })
    .fill('https://x.com/project/status/123456789123456789');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByText('Public post found', { exact: true })).toBeVisible();
  await page.getByLabel('Reward budget (USDC)').fill('2.5');
  await page.getByLabel('Reward budget (USDC)').press('Tab');
  await expect(page.getByLabel('Impression target')).toHaveValue('2500');
  await page.screenshot({
    path: `test-results/studio-editor-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Fund & Launch Raid', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.getByText('2.50 USDC reward pool', { exact: true })).toBeVisible();
  const manageUrl = page.url(),
    id = new URL(manageUrl).pathname.split('/').at(-1)!;
  await page
    .getByLabel('Add a campaign post')
    .fill('https://x.com/project/status/123456789123456790');
  await page.getByRole('button', { name: 'Add post', exact: true }).click();
  await expect(page.getByText('Campaign post added.', { exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: 'Reach target & finish test review', exact: true })
    .click();
  await expect(page.getByText('ALLOCATED', { exact: false })).toBeVisible();
  await expect(page.getByText(/0.625 USDC estimated/)).toBeVisible();
  const report = await page.request.get(`/api/raids/${id}/report`);
  expect(report.ok()).toBe(true);
  expect(await report.text()).toContain('reviewed USDC');
  await page.getByRole('link', { name: 'View public Raid', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Raid these posts' })).toBeVisible();
  await page.goto('/admin');
  const queue = page.locator('#usdc-payments');
  const transfers = await studioDb.usdcTransfer.findMany({
    where: { kind: 'REWARD', allocation: { raidId: id } },
  });
  expect(transfers).toHaveLength(1);
  const transfer = transfers[0];
  expect(transfer).toMatchObject({ amount: 625000n, network: 'sandbox', status: 'REQUESTED' });
  const unrelatedPending = await studioDb.usdcTransfer.findMany({
    where: { status: 'REQUESTED', id: { not: transfer.id } },
    orderBy: { id: 'asc' },
  });
  const memo = `useRAID:usdc:${transfer.id}`;
  const payment = queue.locator('.admin-row').filter({ hasText: memo });
  await expect(payment).toHaveCount(1);
  await expect(
    payment.getByText('REWARD · @test_raider · 0.625 USDC', { exact: true }),
  ).toBeVisible();
  await payment.getByRole('button', { name: 'Confirm test payment' }).click();
  await expect(queue.locator('.admin-row').filter({ hasText: memo })).toHaveCount(0);
  expect(
    await studioDb.usdcTransfer.findUniqueOrThrow({ where: { id: transfer.id } }),
  ).toMatchObject({
    status: 'PAID',
    amount: transfer.amount,
    allocationId: transfer.allocationId,
  });
  expect(
    await studioDb.usdcTransfer.findMany({
      where: { id: { in: unrelatedPending.map((row) => row.id) } },
      orderBy: { id: 'asc' },
    }),
  ).toEqual(unrelatedPending);
  await page.goto('/creator');
  const card = page.locator('.studio-raid-row').filter({ hasText: title });
  await expect(card.getByText(/Paid/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
test('deposit preserves saved draft; wallet and X diagnostics stay out of Studio', async ({
  page,
}) => {
  await page.getByRole('link', { name: 'Create Raid', exact: true }).first().click();
  await page.getByRole('button', { name: /X Campaign No token needed/ }).click();
  await page.getByLabel('Campaign name', { exact: true }).fill(`Large draft ${Date.now()}`);
  await page
    .getByLabel('X post 1', { exact: true })
    .fill('https://x.com/project/status/123456789123456788');
  await page.getByLabel('Impression target').fill('1000000');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
  await page.waitForURL(/\/creator\/new\?draft=/);
  const draftUrl = page.url();
  await page.goto(
    `/creator/balance?returnTo=${encodeURIComponent(new URL(draftUrl).pathname + new URL(draftUrl).search)}`,
  );
  await page.getByLabel('Amount (USDC)').fill('12');
  await page.getByRole('button', { name: 'Add test USDC' }).click();
  await expect(
    page.getByText('Deposit confirmed. USDC is available.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Return to draft', exact: true }).click();
  await expect(page.getByLabel('Impression target')).toHaveValue('1000000');
  await expect(page.getByLabel('X post 1', { exact: true })).toHaveValue(
    'https://x.com/i/web/status/123456789123456788',
  );
  await expect(page.getByText('OAuth diagnostics', { exact: false })).toHaveCount(0);
});
test('existing token uses same editor; Launch Token stays Coming soon', async ({ page }) => {
  await page.getByRole('link', { name: 'Create Raid', exact: true }).first().click();
  await expect(page.getByText('Coming soon', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Existing Token Identify your token/ }).click();
  await page
    .getByLabel('Solana contract address')
    .fill('So11111111111111111111111111111111111111112');
  await expect(page.getByText('Token found', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Campaign name', { exact: true })).not.toHaveValue('');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
test('unapproved creators request approval before they can create a Raid', async ({ page }) => {
  const login = await page.request.post('/api/studio/sandbox', {
    headers: { origin: 'http://localhost:3007' },
    data: { action: 'login', fixtureId: `unapproved-${crypto.randomUUID()}` },
  });
  expect(login.ok()).toBe(true);
  await page.goto('/creator');
  await expect(page.getByRole('heading', { name: 'Creator approval required' })).toBeVisible();
  await page
    .getByLabel('Project affiliation')
    .fill('Founder of the Example project, official site example.com');
  await page.getByRole('button', { name: 'Request creator approval' }).click();
  await expect(page.getByText('Request submitted for administrator review.')).toBeVisible();
  await page.goto('/creator/new');
  await expect(page.getByRole('heading', { name: 'Creator approval required' })).toBeVisible();
  await expect(page.getByLabel('Campaign name', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
test('shows the sign-in result to a signed-in creator and loads under the CSP', async ({
  page,
}) => {
  const problems = watchConsole(page);
  await page.goto('/creator/account?auth=identity');
  await expect(page.getByText(/already tied to another account with activity/)).toBeVisible();
  await page.goto('/creator?auth=connected');
  await expect(page.getByText('X account connected.')).toBeVisible();
  await page.goto('/creator/new');
  await page.waitForLoadState('networkidle');
  expect(problems).toEqual([]);
});
// Studio keeps a pilot-wide cap on live Raids, so tests that launch one end it again.
async function endRaid(page: Page, id: string) {
  const response = await page.request.patch(`/api/raids/${id}`, {
    headers: { origin: 'http://localhost:3007' },
    data: { action: 'end' },
  });
  expect(response.ok()).toBe(true);
}
test('a rejected wallet connection can be retried with the same wallet', async ({ page }) => {
  await page.addInitScript(() => {
    let attempts = 0;
    const wallet = {
      version: '1.0.0',
      name: 'Fake Wallet',
      icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      chains: ['solana:mainnet'],
      accounts: [],
      features: {
        'standard:connect': {
          version: '1.0.0',
          connect: async () => {
            attempts += 1;
            if (attempts === 1) throw new Error('User rejected the request.');
            return {
              accounts: [
                {
                  address: '11111111111111111111111111111111',
                  publicKey: new Uint8Array(32),
                  chains: ['solana:mainnet'],
                  features: ['solana:signMessage'],
                },
              ],
            };
          },
        },
        'solana:signMessage': { version: '1.0.0', signMessage: async () => [] },
      },
    };
    const register = (api: { register: (w: unknown) => void }) => api.register(wallet);
    window.addEventListener('wallet-standard:app-ready', (e) =>
      register((e as CustomEvent).detail),
    );
    window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
  });
  await page.goto('/creator/account');
  await page.getByRole('button', { name: 'Change wallet' }).click();
  const connect = page.getByRole('button', { name: 'Connect Fake Wallet' });
  await connect.click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Request cancelled in wallet' }),
  ).toBeVisible();
  await expect(connect).toBeEnabled();
  const challenge = page.waitForRequest('**/api/wallet/challenge');
  await connect.click();
  await challenge;
});
test('a blocked sessionStorage never breaks the editor or the launch', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('quota', 'QuotaExceededError');
    };
    Storage.prototype.removeItem = () => {
      throw new Error('blocked');
    };
    Storage.prototype.getItem = () => {
      throw new Error('blocked');
    };
  });
  const problems = watchConsole(page);
  await page.goto('/creator/new');
  await page.getByRole('button', { name: /X Campaign No token needed/ }).click();
  const title = `Blocked storage ${Date.now()}`;
  await page.getByLabel('Campaign name', { exact: true }).fill(title);
  await expect(page.getByLabel('Campaign name', { exact: true })).toHaveValue(title);
  await page
    .getByLabel('X post 1', { exact: true })
    .fill('https://x.com/project/status/123456789123456791');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByText('Public post found', { exact: true })).toBeVisible();
  await page.getByLabel('Reward budget (USDC)').fill('2.5');
  await page.getByLabel('Reward budget (USDC)').press('Tab');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Fund & Launch Raid', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  expect(problems.filter((p) => !/quota|blocked/i.test(p))).toEqual([]);
  await endRaid(page, new URL(page.url()).pathname.split('/').at(-1)!);
});
test('the creator manage page links to the public page and report only when they exist', async ({
  page,
}) => {
  await page.goto('/creator/new');
  await page.getByRole('button', { name: /X Campaign No token needed/ }).click();
  const title = `Manage links ${Date.now()}`;
  await page.getByLabel('Campaign name', { exact: true }).fill(title);
  await page
    .getByLabel('X post 1', { exact: true })
    .fill('https://x.com/project/status/123456789123456792');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
  await page.waitForURL(/\/creator\/new\?draft=/);
  const id = new URL(page.url()).searchParams.get('draft');
  await page.goto(`/creator/raids/${id}`);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'View public Raid' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Download campaign report' })).toHaveCount(0);
  await expect(page.getByText('The public page and report become available')).toBeVisible();
  await page.goto(`/creator/new?draft=${id}`);
  await page.getByLabel('Reward budget (USDC)').fill('2.5');
  await page.getByLabel('Reward budget (USDC)').press('Tab');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Fund & Launch Raid', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'View public Raid' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download campaign report' })).toBeVisible();
  const report = await page.request.get(`/api/raids/${id}/report`);
  expect(report.status()).toBe(200);
  await expect(page.getByText('The public page and report become available')).toHaveCount(0);
  await endRaid(page, id!);
});
test('studio filters, navigation and the account menu are accessible', async ({ page }) => {
  await expect(page.getByRole('group', { name: 'Filter Raids' })).toBeVisible();
  await page.goto('/creator/new');
  await expect(page.locator('nav.desktop-nav a[href="/creator"]')).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.getByRole('button', { name: /X Campaign No token needed/ }).click();
  await expect(page.getByRole('group', { name: 'Campaign duration' })).toBeVisible();
  await expect(page.locator('main').getByRole('status')).toHaveCount(1);
  await expect(page.locator('main').getByRole('alert')).toHaveCount(1);
  await page.getByRole('button', { name: /^@test_creator/ }).click();
  await expect(page.getByRole('link', { name: 'Account', exact: true })).toBeFocused();
});
