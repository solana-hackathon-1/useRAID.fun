import { Keypair } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { db } from './db';
import { studioSandbox, lockBalance } from './usdc';
import { HttpError } from './errors';
import { ingestTracking } from './tracking';
import { completeImpressionTarget } from './raid-progress';
import { finalizeTracking } from './tracking-review';
import { allocateUsdcRaid } from './studio-finance';

export function requireStudioSandbox() {
  if (!studioSandbox()) throw new HttpError(404, 'Not found.');
}
export async function sandboxUser(fixtureId?: string) {
  requireStudioSandbox();
  if (fixtureId && !/^[a-zA-Z0-9-]{1,80}$/.test(fixtureId))
    throw new HttpError(400, 'Invalid fixture ID.');
  const xId = fixtureId ? `studio-test-${fixtureId}` : 'studio-local-creator';
  const user = await db.user.upsert({
    where: { xId },
    create: { xId, handle: 'test_creator', role: 'ADMIN' },
    update: {},
  });
  await db.xAccount.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      xUserId: user.xId!,
      username: user.handle,
      displayName: 'Test Creator',
    },
    update: {},
  });
  const address = Keypair.fromSeed(
    fixtureId ? createHash('sha256').update(xId).digest() : new Uint8Array(32).fill(18),
  ).publicKey.toBase58();
  await db.walletIdentity.upsert({
    where: { userId: user.id },
    create: { userId: user.id, address },
    update: {},
  });
  await db.settings.upsert({
    where: { id: 'global' },
    create: { collectionEnabled: true },
    update: {},
  });
  await db.$transaction(async (tx) => {
    await lockBalance(tx, user.id);
    const key = `studio-starting-balance:${user.id}`;
    if (!(await tx.balanceEntry.findFirst({ where: { userId: user.id, kind: 'TEST_FUNDS' } })))
      await tx.balanceEntry.create({
        data: {
          key,
          userId: user.id,
          network: 'sandbox',
          kind: 'TEST_FUNDS',
          availableDelta: 1000_000_000n,
          reservedDelta: 0n,
        },
      });
  });
  return user;
}
export async function sandboxContribution(raidId: string, creatorId: string, complete: boolean) {
  requireStudioSandbox();
  const raid = await db.raid.findUnique({ where: { id: raidId }, include: { briefPosts: true } });
  if (
    !raid ||
    raid.creatorId !== creatorId ||
    raid.studioVersion !== 1 ||
    raid.fundingNetwork !== 'sandbox'
  )
    throw new HttpError(404, 'Test Raid not found.');
  if (raid.status !== 'ACTIVE') throw new HttpError(409, 'Launch test Raid first.');
  const raider = await db.user.upsert({
    where: { xId: `studio-test-raider-${raidId}` },
    create: { xId: `studio-test-raider-${raidId}`, handle: 'test_raider' },
    update: {},
  });
  const wallet = Keypair.fromSeed(new Uint8Array(32).fill(23)).publicKey.toBase58();
  await db.raidEnrollment.upsert({
    where: { raidId_userId: { raidId, userId: raider.id } },
    create: { raidId, userId: raider.id, xId: raider.xId!, walletAddress: wallet },
    update: {},
  });
  const post = {
    id: `${Date.now()}00001`,
    author_id: raider.xId!,
    created_at: new Date().toISOString(),
    text: `Local test contribution ${Date.now()} @${raid.officialHandle}`,
    entities: { mentions: [{ username: raid.officialHandle }] },
    referenced_tweets: [{ type: 'quoted' as const, id: raid.briefPosts[0].postId }],
    public_metrics: {
      like_count: 12,
      reply_count: 3,
      retweet_count: 4,
      quote_count: 2,
      impression_count: complete
        ? raid.impressionTarget!
        : Math.max(1, Math.floor(raid.impressionTarget! / 4)),
    },
  };
  await ingestTracking(raidId, [post], { source: 'STUDIO_SANDBOX' });
  await db.raid.update({
    where: { id: raidId },
    data: { coverage: 'complete', observedAt: new Date(), collectionError: null },
  });
  await completeImpressionTarget(raidId);
  if (complete) {
    const ended = await db.raid.findUniqueOrThrow({ where: { id: raidId } });
    await ingestTracking(raidId, [post], { source: 'STUDIO_SANDBOX_FINAL' });
    await db.post.updateMany({ where: { raidId }, data: { observedAt: new Date() } });
    await db.raid.update({
      where: { id: raidId },
      data: {
        finalRefreshed: true,
        coveredUntil: ended.endsAt,
        coverage: 'complete',
        nextToken: null,
        searchEndAt: null,
        searchQuery: null,
      },
    });
    await finalizeTracking(raidId);
    await db.raid.update({
      where: { id: raidId },
      data: { reviewEndsAt: new Date(Date.now() - 1) },
    });
    await finalizeTracking(raidId);
    await allocateUsdcRaid(raidId);
  }
}
