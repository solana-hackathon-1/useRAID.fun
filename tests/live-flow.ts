import { chromium, expect } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { db as appDb } from '../src/lib/db';
import { assertTestDatabase } from './helpers/db-guard';
assertTestDatabase();
const db = new PrismaClient();
const suffix = randomBytes(4).toString('hex');
const server = spawn('node', ['node_modules/next/dist/bin/next', 'start', '--port', '3001'], {
  env: {
    ...process.env,
    DEMO_MODE: 'false',
    APP_URL: 'http://localhost:3001',
    NEXT_PUBLIC_APP_URL: 'http://localhost:3001',
    LIVE_COLLECTION_APPROVED: 'false',
    X_ADMIN_USER_ID: `admin-${suffix}`,
  },
  stdio: 'ignore',
});
const browser = await chromium.launch();
const cleanupUserIds: string[] = [];
try {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch('http://localhost:3001/api/health')).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  await db.settings.upsert({
    where: { id: 'global' },
    create: { maxActiveRaids: 10, maxCreators: 5 },
    update: { maxActiveRaids: 10, maxCreators: 5, collectionEnabled: false },
  });
  const admin = await db.user.create({
    data: { xId: `admin-${suffix}`, handle: `admin_${suffix}`, role: 'ADMIN', approved: true },
  });
  cleanupUserIds.push(admin.id);
  const creator = await db.user.create({
    data: {
      xId: `creator-${suffix}`,
      handle: `creator_${suffix}`,
      affiliation: 'I maintain the test project. Test-only affiliation evidence.',
    },
  });
  cleanupUserIds.push(creator.id);
  await db.xAccount.create({
    data: {
      userId: creator.id,
      xUserId: creator.xId!,
      username: creator.handle,
      displayName: 'Browser fixture',
    },
  });
  async function session(userId: string) {
    const token = randomBytes(32).toString('hex');
    await db.session.create({
      data: {
        tokenHash: createHash('sha256').update(token).digest('hex'),
        userId,
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: 'raid_session',
        value: token,
        url: 'http://localhost:3001',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    return context;
  }
  const adminContext = await session(admin.id),
    creatorContext = await session(creator.id);
  const adminPage = await adminContext.newPage();
  await adminPage.goto('http://localhost:3001/admin');
  const row = adminPage.locator('.admin-row').filter({ hasText: `@creator_${suffix}` });
  await row
    .getByRole('textbox', { name: 'Reason: Approve creator' })
    .fill('Approved fixture for browser acceptance test');
  await row.getByRole('button', { name: 'Approve creator', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Revoke approval', exact: true })).toBeVisible();
  const page = await creatorContext.newPage();
  await page.goto('http://localhost:3001/creator');
  await expect(page.getByRole('heading', { name: 'Creator Studio', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Creator approval required' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Create Raid', exact: true }).first().click();
  await page.getByRole('button', { name: /X Campaign No token needed/ }).click();
  await page.getByLabel('Campaign name', { exact: true }).fill(`Browser campaign ${suffix}`);
  await page
    .getByLabel('X post 1', { exact: true })
    .fill('https://x.com/project/status/123456789123456789');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
  await page.waitForURL(/\/creator\/new\?draft=/);
  const draft = await db.raid.findFirstOrThrow({
    where: { creatorId: creator.id },
    include: { briefPosts: true },
  });
  expect(draft).toMatchObject({ studioVersion: 1, status: 'DRAFT', fundingAsset: 'USDC' });
  expect(draft.briefPosts.map((p) => p.postId)).toEqual(['123456789123456789']);
  // This server has no funding rate, X credentials or approved collection, so launch must refuse.
  const launch = await page.request.patch(`http://localhost:3001/api/raids/${draft.id}`, {
    headers: { origin: 'http://localhost:3001' },
    data: { action: 'fund-launch', expectedUnits: '1000000', termsAccepted: true },
  });
  expect(launch.status()).toBe(503);
  expect(await launch.text()).toContain('Live campaign funding is not ready');
  expect((await db.raid.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('DRAFT');
  // Stand in for the funded, X-validated launch, which needs the live X API and a USDC deposit.
  const raid = await db.raid.update({
    where: { id: draft.id },
    data: { status: 'ACTIVE', coverage: 'complete', observedAt: new Date() },
  });
  await page.goto(`http://localhost:3001/creator/raids/${raid.id}`);
  await expect(
    page.getByRole('heading', { name: `Browser campaign ${suffix}`, exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'View public Raid', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Raid these posts' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Raid on X' })).toHaveAttribute(
    'href',
    /status%2F123456789123456789/,
  );
  await expect(page.getByRole('button', { name: 'Trading · Coming soon' })).toBeDisabled();
  const denied = await page.request.post('http://localhost:3001/api/admin/settings', {
    headers: { origin: 'http://localhost:3001' },
    data: {},
  });
  expect(denied.status()).toBe(403);
  const crossOrigin = await page.request.post('http://localhost:3001/api/raids', {
    headers: { origin: 'https://other.example' },
    data: {},
  });
  expect(crossOrigin.status()).toBe(403);
  await page.screenshot({ path: 'artifacts/raid-live-fixture.png', fullPage: true });
  await page.goto('http://localhost:3001/creator/account');
  await expect(page.getByRole('heading', { name: 'X Connected' })).toBeVisible();
  await page.route('**/api/auth/x/disconnect', (route) =>
    route.fulfill({ status: 500, json: { error: 'Fixture error' } }),
  );
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'X account connection' }).getByRole('alert'),
  ).toContainText('Could not disconnect X');
  await page.unroute('**/api/auth/x/disconnect');
  let releaseDisconnect!: () => void;
  const pendingDisconnect = new Promise<void>((resolve) => {
    releaseDisconnect = resolve;
  });
  await page.route('**/api/auth/x/disconnect', async (route) => {
    await pendingDisconnect;
    await route.continue();
  });
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disconnecting…' })).toBeDisabled();
  releaseDisconnect();
  await page.waitForURL('http://localhost:3001/creator');
  await page.goto('http://localhost:3001/creator/account');
  await expect(page.getByRole('link', { name: 'Connect X', exact: true })).toBeVisible();
  expect(await db.xAccount.count({ where: { userId: creator.id } })).toBe(0);
  expect(await db.raid.findUnique({ where: { id: raid.id } })).not.toBeNull();
  await page.goto('http://localhost:3001/creator/account?auth=cancelled');
  await expect(
    page.getByRole('region', { name: 'X account connection' }).getByRole('alert'),
  ).toContainText('X authorization was cancelled');
  await page.route(/\/api\/auth\/x\?/, async (route) => {
    await route.fulfill({ status: 303, headers: { location: '/creator/account?auth=state' } });
  });
  await page.getByRole('link', { name: 'Connect X', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'X account connection' }).getByRole('alert'),
  ).toContainText('Authorization expired or was invalid');
  await page.unroute(/\/api\/auth\/x\?/);
  await page.goto(`http://localhost:3001/creator/raids/${raid.id}`);
  await page.getByText('End Raid early').click();
  await page.getByRole('button', { name: 'End campaign' }).click();
  await expect(page.getByRole('button', { name: 'End campaign' })).toHaveCount(0);
  await expect
    .poll(async () => (await db.raid.findUniqueOrThrow({ where: { id: raid.id } })).status)
    .toBe('ENDED');
  console.log(
    'PASS: admin approval → Creator Studio draft → launch gate → public raid → end; X connection UI, disconnect, errors, and history preservation verified; admin and cross-origin authorization enforced.',
  );
} finally {
  await browser.close();
  server.kill('SIGTERM');
  const fixtureRaids = await db.raid.findMany({
    where: { creatorId: { in: cleanupUserIds } },
    select: { id: true },
  });
  const ids = fixtureRaids.map((r) => r.id);
  await db.post.deleteMany({ where: { raidId: { in: ids } } });
  await db.raidBriefPost.deleteMany({ where: { raidId: { in: ids } } });
  await db.snapshot.deleteMany({ where: { raidId: { in: ids } } });
  await db.event.deleteMany({ where: { raidId: { in: ids } } });
  await db.raid.deleteMany({ where: { id: { in: ids } } });
  await db.moderationEvent.deleteMany({ where: { actorId: { in: cleanupUserIds } } });
  await db.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  await Promise.all([db.$disconnect(), appDb.$disconnect()]);
}
