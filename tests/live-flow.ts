import { chromium, expect } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { ingest } from '../src/lib/collection';
import { db as appDb } from '../src/lib/db';
import { assertTestDatabase } from './helpers/db-guard';
assertTestDatabase();
const db = new PrismaClient();
const server = spawn('node', ['node_modules/next/dist/bin/next', 'start', '--port', '3001'], {
  env: {
    ...process.env,
    DEMO_MODE: 'false',
    APP_URL: 'http://localhost:3001',
    NEXT_PUBLIC_APP_URL: 'http://localhost:3001',
    LIVE_COLLECTION_APPROVED: 'false',
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
  const suffix = randomBytes(4).toString('hex');
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
  await page.getByLabel('Campaign title').fill(`Browser campaign ${suffix}`);
  await page
    .getByLabel('Description', { exact: true })
    .fill('A controlled browser test campaign for community participation.');
  await page.getByLabel('Solana token mint').fill('So11111111111111111111111111111111111111112');
  await page.getByLabel('Token symbol', { exact: true }).fill('SOL');
  await page.getByLabel('Token name', { exact: true }).fill('Solana');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Launch / schedule' }).click();
  await expect(page.getByRole('button', { name: 'End campaign' })).toBeVisible();
  const raid = await db.raid.findFirstOrThrow({
    where: { creatorId: creator.id, status: 'ACTIVE' },
  });
  // Exercise the same ingest adapter with a controlled provider fixture; no network request.
  await ingest(raid.id, [
    {
      id: `9${Date.now()}`,
      author_id: 'browser_author',
      text: `Original browser fixture @useRAID #${raid.tag}`,
      created_at: new Date().toISOString(),
      entities: { mentions: [{ username: 'useRAID' }], hashtags: [{ tag: raid.tag }] },
      public_metrics: { like_count: 3, reply_count: 2, quote_count: 1, retweet_count: 0 },
    },
  ]);
  await db.raid.update({
    where: { id: raid.id },
    data: { coverage: 'complete', observedAt: new Date() },
  });
  await page.getByRole('link', { name: 'View raid', exact: true }).click();
  await expect(page.getByText('Original browser fixture', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Trade on Jupiter' })).toHaveAttribute(
    'href',
    /So11111111111111111111111111111111111111112/,
  );
  await expect(page.getByRole('link', { name: 'Raid on X' })).toHaveAttribute(
    'href',
    new RegExp(raid.tag),
  );
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
  await page.goto('http://localhost:3001/creator');
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
  await expect(page.getByRole('button', { name: 'Connect X', exact: true })).toBeVisible();
  expect(await db.xAccount.count({ where: { userId: creator.id } })).toBe(0);
  expect(await db.raid.findUnique({ where: { id: raid.id } })).not.toBeNull();
  await page.goto('http://localhost:3001/creator?auth=cancelled');
  await expect(
    page.getByRole('region', { name: 'X account connection' }).getByRole('alert'),
  ).toContainText('X authorization was cancelled');
  await page.route('**/api/auth/x', async (route) => {
    await route.fulfill({ status: 303, headers: { location: '/creator?auth=state' } });
  });
  await page.getByRole('button', { name: 'Connect X', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'X account connection' }).getByRole('alert'),
  ).toContainText('Authorization expired or was invalid');
  await page.unroute('**/api/auth/x');
  await page.getByRole('button', { name: 'End campaign' }).click();
  await expect(page.getByRole('button', { name: 'End campaign' })).toHaveCount(0);
  console.log(
    'PASS: admin approval → creator draft → launch → fixture ingestion → public raid → exact-mint trade link → end; X connection UI, disconnect, errors, and history preservation verified; admin and cross-origin authorization enforced.',
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
  await db.snapshot.deleteMany({ where: { raidId: { in: ids } } });
  await db.event.deleteMany({ where: { raidId: { in: ids } } });
  await db.raid.deleteMany({ where: { id: { in: ids } } });
  await db.moderationEvent.deleteMany({ where: { actorId: { in: cleanupUserIds } } });
  await db.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  await Promise.all([db.$disconnect(), appDb.$disconnect()]);
}
