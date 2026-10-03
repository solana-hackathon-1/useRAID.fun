import { test, expect } from '@playwright/test';
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
  await expect(
    queue.getByText('REWARD · @test_raider · 0.625 USDC', { exact: true }),
  ).toBeVisible();
  const payment = queue
    .locator('.admin-row')
    .filter({ hasText: 'REWARD · @test_raider · 0.625 USDC' })
    .last();
  const memo = (await payment.locator('code').textContent())!;
  await payment.getByRole('button', { name: 'Confirm test payment' }).click();
  await expect(queue.locator('.admin-row').filter({ hasText: memo })).toHaveCount(0);
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
