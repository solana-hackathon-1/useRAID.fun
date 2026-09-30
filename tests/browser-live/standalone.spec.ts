import { test, expect } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { db } from '../../src/lib/db';

let session: string;

test.beforeAll(async () => {
  if (new URL(process.env.DATABASE_URL || 'http://invalid').pathname !== '/useraid_test')
    throw Error('Use dedicated useraid_test database.');
  await db.$executeRawUnsafe('TRUNCATE "User", "Token", "Job", "RateLimit" CASCADE');
  const creator = await db.user.create({
    data: { xId: 'standalone-creator', handle: 'standalone', approved: true },
  });
  await db.xAccount.create({
    data: {
      userId: creator.id,
      xUserId: creator.xId!,
      username: 'standalone',
      displayName: 'Standalone Creator',
    },
  });
  session = randomBytes(32).toString('base64url');
  await db.session.create({
    data: {
      userId: creator.id,
      tokenHash: createHash('sha256').update(session).digest('hex'),
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
});

test.afterAll(async () => {
  await db.$executeRawUnsafe('TRUNCATE "User", "Token", "Job", "RateLimit" CASCADE');
  await db.$disconnect();
});

test('creator saves non-token Raid, adds campaign post, and cannot launch before funding', async ({
  page,
}) => {
  await page
    .context()
    .addCookies([{ name: 'raid_session', value: session, url: 'http://localhost:3006' }]);
  await page.goto('/creator');
  const sandbox = await page.request.post('/api/studio/sandbox', { data: { action: 'login' } });
  expect(sandbox.status()).toBe(404);
  await page.getByRole('link', { name: 'Create Raid', exact: true }).first().click();
  await page.getByRole('button', { name: /X Campaign No token needed/ }).click();
  await page.getByLabel('Campaign name').fill('Independent project Raid');
  await page
    .getByLabel('X post 1', { exact: true })
    .fill('https://x.com/standalone/status/123456789123456789');
  await page.getByLabel('Impression target').fill('2000');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved.')).toBeVisible();
  await expect(page.getByText('Pricing is not configured.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Launch / schedule' })).toHaveCount(0);
  const raid = await db.raid.findFirstOrThrow({ where: { title: 'Independent project Raid' } });
  expect(raid.studioVersion).toBe(1);
  expect(await db.raidBriefPost.count({ where: { raidId: raid.id } })).toBe(1);
});
