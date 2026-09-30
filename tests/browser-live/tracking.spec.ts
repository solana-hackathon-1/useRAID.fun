import { test, expect } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { db } from '../../src/lib/db';
import { ingestTracking } from '../../src/lib/tracking';
import { finalizeTracking } from '../../src/lib/tracking-review';
let raidId: string, userId: string, token: string;
test.beforeAll(async () => {
  if (new URL(process.env.DATABASE_URL || 'http://invalid').pathname !== '/useraid_test')
    throw Error('Use dedicated useraid_test database.');
  process.env.X_TRACKING_V2_ENABLED = 'true';
  await db.$executeRawUnsafe('TRUNCATE "User", "Token", "Job", "RateLimit" CASCADE');
  const user = await db.user.create({ data: { xId: 'browser-tracker', handle: 'tracker' } });
  userId = user.id;
  await db.xAccount.create({
    data: { userId, xUserId: user.xId!, username: 'tracker', displayName: 'Tracker' },
  });
  await db.walletIdentity.create({ data: { userId, address: '11111111111111111111111111111111' } });
  token = randomBytes(32).toString('base64url');
  await db.session.create({
    data: {
      userId,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  const mint = 'So11111111111111111111111111111111111111112';
  await db.token.create({ data: { mint, name: 'Tracked token', symbol: 'TRACK' } });
  raidId = (
    await db.raid.create({
      data: {
        mint,
        creatorId: userId,
        tag: 'raid_browser_tracking',
        title: 'Tracked Raid',
        description: 'Verified contribution browser journey.',
        startsAt: new Date(Date.now() - 3600000),
        endsAt: new Date(Date.now() + 3600000),
        status: 'ACTIVE',
        trackingVersion: 2,
        ruleVersion: 3,
        scoringVersion: 2,
      },
    })
  ).id;
});
test.afterAll(async () => {
  await db.$executeRawUnsafe('TRUNCATE "User", "Token", "Job" CASCADE');
  await db.$disconnect();
});
test('join, submit, qualify, refresh, review, dispute, and payout eligibility', async ({
  page,
}) => {
  await page
    .context()
    .addCookies([{ name: 'raid_session', value: token, url: 'http://localhost:3006' }]);
  await page.goto(`/raids/${raidId}`);
  await expect(page.getByRole('link', { name: 'Raid on X' })).toHaveAttribute(
    'href',
    'https://x.com/intent/post?text=%40useRAID%0A%0A',
  );
  await expect(page.getByText(/If you joined overlapping Raids/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Join Raid', exact: true }).click();
  await expect(page.getByText('Joined. Posts created from now on can qualify.')).toBeVisible();
  await page
    .getByPlaceholder('https://x.com/you/status/…')
    .fill('https://x.com/tracker/status/123456789');
  await page.getByRole('button', { name: 'Submit post URL' }).click();
  await expect(page.getByText('Post queued for identity and qualification checks.')).toBeVisible();
  const member = await db.raidEnrollment.findFirstOrThrow({ where: { raidId, userId } });
  const submission = await db.postSubmission.findFirstOrThrow({ where: { raidId } });
  const post = {
    id: '123456789',
    author_id: 'browser-tracker',
    text: 'Our original community update @useRAID',
    created_at: new Date(+member.joinedAt + 1).toISOString(),
    entities: { mentions: [{ username: 'useRAID' }] },
    public_metrics: { like_count: 3, reply_count: 0, retweet_count: 0, quote_count: 0 },
  };
  // Provider boundaries are deterministic fixtures; no X request or SOL transfer occurs.
  await ingestTracking(raidId, [post], { submissionId: submission.id, sampleKey: 'browser-first' });
  await db.job.updateMany({ where: { kind: 'submission' }, data: { doneAt: new Date() } });
  await page.reload();
  await expect(page.getByText('1/1 qualified · 1/10 scored')).toBeVisible();
  await expect(page.getByText('#1 @tracker — 300 Attention')).toBeVisible();
  await ingestTracking(
    raidId,
    [{ ...post, public_metrics: { ...post.public_metrics, like_count: 7 } }],
    { sampleKey: 'browser-refresh' },
  );
  await page.reload();
  await expect(page.getByText('#1 @tracker — 400 Attention')).toBeVisible();
  await db.raid.update({
    where: { id: raidId },
    data: {
      status: 'ENDED',
      endsAt: new Date(+member.joinedAt + 2),
      trackingPhase: 'FINALIZING',
      finalRefreshed: true,
      coverage: 'complete',
      coveredUntil: new Date(),
      observedAt: new Date(),
    },
  });
  await finalizeTracking(raidId);
  await page.reload();
  await expect(page.getByText(/Result version 1/)).toBeVisible();
  await page.getByLabel('Reason', { exact: true }).fill('Please verify my final metrics.');
  await page.getByRole('button', { name: 'Submit dispute' }).click();
  await expect(page.getByText('Dispute recorded. Results remain under review.')).toBeVisible();
  const admin = await db.user.create({ data: { handle: 'reviewer', role: 'ADMIN' } });
  const dispute = await db.raidDispute.findFirstOrThrow({ where: { raidId } });
  const { resolveTracking } = await import('../../src/lib/tracking-review');
  await resolveTracking(raidId, admin.id, {
    action: 'reject-dispute',
    disputeId: dispute.id,
    reason: 'The final observation matches provider fixture.',
  });
  await db.raid.update({ where: { id: raidId }, data: { reviewEndsAt: new Date(Date.now() - 1) } });
  await finalizeTracking(raidId);
  await page.reload();
  await expect(page.getByText('Results collected · APPROVED')).toBeVisible();
});
