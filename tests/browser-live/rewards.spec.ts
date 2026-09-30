import { test, expect } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { db } from '../../src/lib/db';
test.describe.skip('deferred launchpad and creator-fee rewards', () => {
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

let mint = '';
let launchId = '';
let newParticipantSession = '';
let paidParticipantSession = '';

test.beforeAll(async () => {
  if (new URL(process.env.DATABASE_URL || 'http://invalid').pathname !== '/useraid_test')
    throw Error('Use dedicated useraid_test database.');
  await db.$executeRawUnsafe('TRUNCATE "User", "Token" CASCADE');
  await db.settings.upsert({
    where: { id: 'global' },
    create: {
      collectionEnabled: true,
      payoutWorkerAt: new Date(),
      operatorAddress: '11111111111111111111111111111111',
    },
    update: {
      collectionEnabled: true,
      launchPaused: false,
      payoutPaused: false,
      payoutWorkerAt: new Date(),
      operatorAddress: '11111111111111111111111111111111',
    },
  });
  mint = 'So11111111111111111111111111111111111111112';
  const owner = await db.user.create({ data: { handle: 'launch-owner' } });
  const newcomer = await db.user.create({ data: { xId: 'browser-new', handle: 'new-raider' } });
  const paid = await db.user.create({ data: { xId: 'browser-paid', handle: 'paid-raider' } });
  await Promise.all([
    db.walletIdentity.create({
      data: { userId: newcomer.id, address: 'EPjFWdd5AufqSSqeM2q6VQ8p45QnQ4vZ6L3kmwB1F8xG' },
    }),
    db.walletIdentity.create({
      data: { userId: paid.id, address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
    }),
    db.xAccount.create({
      data: { userId: newcomer.id, xUserId: 'browser-new', username: 'new', displayName: 'New' },
    }),
    db.xAccount.create({
      data: { userId: paid.id, xUserId: 'browser-paid', username: 'paid', displayName: 'Paid' },
    }),
  ]);
  newParticipantSession = randomBytes(32).toString('base64url');
  paidParticipantSession = randomBytes(32).toString('base64url');
  await Promise.all([
    db.session.create({
      data: {
        userId: newcomer.id,
        tokenHash: hash(newParticipantSession),
        expiresAt: new Date(Date.now() + 3600000),
      },
    }),
    db.session.create({
      data: {
        userId: paid.id,
        tokenHash: hash(paidParticipantSession),
        expiresAt: new Date(Date.now() + 3600000),
      },
    }),
  ]);
  await db.token.create({ data: { mint, name: 'Browser Token', symbol: 'BROWSE' } });
  const launch = await db.tokenLaunch.create({
    data: {
      userId: owner.id,
      mint,
      name: 'Browser Token',
      symbol: 'BROWSE',
      description: 'Browser reward history test token.',
      metadataUri: 'ipfs://bafybeigdyrzt4j5q2p3x7uh5tlvnruzbwpjlvszwncln6q2jv7idv2uyvu',
      imageUri: '',
      feeAddress: 'SysvarRent111111111111111111111111111111111',
      feeSecret: 'fixture',
      mintSecret: 'fixture',
      status: 'LIVE',
    },
  });
  launchId = launch.id;
  const now = new Date();
  const raid = await db.raid.create({
    data: {
      tag: `raid_browser_${mint.slice(0, 8)}`,
      title: 'Browser launch raid',
      description: 'Browser launch reward raid.',
      mint,
      creatorId: owner.id,
      tokenLaunchId: launch.id,
      status: 'ACTIVE',
      startsAt: new Date(+now - 3600000),
      endsAt: new Date(+now + 23 * 3600000),
    },
  });
  await db.tokenLaunch.update({ where: { id: launch.id }, data: { raidId: raid.id } });
  const round = await db.rewardRound.create({
    data: {
      launchId: launch.id,
      raidId: raid.id,
      startsAt: new Date(+now - 3600000),
      endsAt: now,
      status: 'SETTLED',
      grossLamports: 2_000_000n,
      costLamports: 10_000n,
      raiderLamports: 1_791_000n,
      platformLamports: 199_000n,
    },
  });
  await db.rewardPayout.create({
    data: {
      launchId: launch.id,
      roundId: round.id,
      xId: 'browser-paid',
      walletAddress: (await db.walletIdentity.findUniqueOrThrow({ where: { userId: paid.id } }))
        .address,
      score: 100,
      lamports: 1_791_000n,
      status: 'PAID',
      signature: 'browser-payout-signature',
      paidAt: now,
    },
  });
});

test.afterAll(async () => {
  await db.$executeRawUnsafe('TRUNCATE "User", "Token" CASCADE');
  await db.$disconnect();
});

async function signedIn(page: import('@playwright/test').Page, token: string) {
  await page
    .context()
    .addCookies([{ name: 'raid_session', value: token, url: 'http://localhost:3006' }]);
}

test('verified participant enrolls for active launch raid', async ({ page }) => {
  await signedIn(page, newParticipantSession);
  await page.goto(`/tokens/${mint}`);
  await page.getByRole('button', { name: 'Join raider rewards' }).click();
  await expect(page.getByText('Enrolled for rewards.')).toBeVisible();
  await expect(page.getByText(/Enrolled ·/)).toBeVisible();
  expect(await db.rewardEnrollment.count({ where: { launchId, xId: 'browser-new' } })).toBe(1);
});

test('SOL-only launch form works on desktop and mobile', async ({ page }) => {
  await signedIn(page, newParticipantSession);
  await page.goto('/launch');
  await expect(page.getByRole('heading', { name: 'Launch on pump.fun' })).toBeVisible();
  await expect(page.getByLabel(/Name ·/)).toBeVisible();
  await expect(page.getByLabel(/Ticker ·/)).toBeVisible();
  await expect(page.getByLabel(/Logo ·/)).toBeVisible();
  await expect(page.getByText('1 · Token details')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('token shows settled split and completed payout link', async ({ page }) => {
  await signedIn(page, paidParticipantSession);
  await page.goto(`/tokens/${mint}`);
  await expect(page.getByText(/Your rewards:.*paid/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Completed payouts' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Transaction' })).toHaveAttribute(
    'href',
    /solscan\.io\/tx\//,
  );
  await expect(page.getByText(/0\.00179 SOL raiders/)).toBeVisible();
});
});
