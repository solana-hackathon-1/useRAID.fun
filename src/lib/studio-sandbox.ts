import { prepareIdentity, identityWriter, identityClock } from './identity-protocol';
import { runCommandTransaction } from './command-receipts-adapter';
import { replanIdentity } from '../identity-locks';
import { Keypair } from '@solana/web3.js';
import { createHash, randomUUID } from 'node:crypto';
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
  const address = Keypair.fromSeed(
    fixtureId ? createHash('sha256').update(xId).digest() : new Uint8Array(32).fill(18),
  ).publicKey.toBase58();
  const user = await fixtureAccount(xId, 'test_creator', address);
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
  const raider = await fixtureAccount(`studio-test-raider-${raidId}`, 'test_raider');
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

async function fixtureAccount(xId: string, handle: string, address?: string) {
  const newId = randomUUID();
  return runCommandTransaction(db, async (_port, tx) => {
    const observed = await tx.user.findUnique({ where: { xId } });
    const locks = await prepareIdentity(tx, {
      accounts: [
        {
          id: observed?.id || newId,
          mode: observed ? 'NO KEY UPDATE' : 'UPDATE',
          create: !observed,
        },
      ],
      xIds: [xId],
      subjects: address ? [address] : [],
    });
    const existing = await tx.user.findUnique({ where: { xId } });
    if (existing?.id !== observed?.id) replanIdentity();
    const writes = identityWriter(tx, locks);
    const user =
      existing ||
      (await writes.user.create({
        data: { id: newId, xId, handle, ...(address ? { role: 'ADMIN' } : {}) },
      }));
    if (address) {
      await writes.xAccount.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
          xUserId: xId,
          username: user.handle,
          displayName: 'Test Creator',
        },
        update: {},
      });
      await writes.walletIdentity.upsert({
        where: { userId: user.id },
        create: { userId: user.id, address },
        update: {},
      });
    }
    return user;
  });
}
export async function createSandboxSession(userId: string, tokenHash: string) {
  requireStudioSandbox();
  await runCommandTransaction(db, async (_port, tx) => {
    const locks = await prepareIdentity(tx, { accounts: [{ id: userId, mode: 'SHARE' }] });
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.suspended) throw new HttpError(403, 'Account suspended.');
    const now = await identityClock(tx);
    await identityWriter(tx, locks).session.create({
      data: { userId, tokenHash, expiresAt: new Date(now.getTime() + 24 * 3600000) },
    });
  });
}
