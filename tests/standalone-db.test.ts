import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { db } from '../src/lib/db';
import { createRaid, changeRaid } from '../src/lib/campaigns';
import { completeImpressionTarget } from '../src/lib/raid-progress';
import { allocateRaidFunding } from '../src/lib/raid-allocation';
import { config } from '../src/lib/config';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
const suite = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;

suite('standalone Raid database lifecycle', () => {
  let ownerId: string, raidId: string;
  beforeAll(async () => {
    assertTestDatabase();
    vi.stubEnv('X_TRACKING_V2_ENABLED', 'true');
    vi.stubEnv('X_TRACKING_V2_SETTLEMENT_ENABLED', 'true');
    vi.stubEnv('RAID_LAMPORTS_PER_1000_IMPRESSIONS', '1000000000');
    vi.stubEnv('RAID_FUNDING_ADDRESS', Keypair.generate().publicKey.toBase58());
    vi.stubEnv('X_BEARER_TOKEN', 'fixture');
    vi.stubEnv('SOLANA_RPC_URL', 'https://example.invalid');
    config.demo = false;
    config.liveApproved = true;
    await truncateAll(db);
    const owner = await db.user.create({ data: { xId: 'owner', handle: 'owner', approved: true } });
    ownerId = owner.id;
    await db.xAccount.create({
      data: { userId: ownerId, xUserId: 'owner', username: 'owner', displayName: 'Owner' },
    });
    const raid = await createRaid(owner, {
      projectType: 'PROJECT',
      title: 'Standalone campaign',
      description: 'A funded campaign for independent projects.',
      symbol: 'PROJ',
      name: 'Independent Project',
      fundingRequest: 'Fund qualifying raider impressions in SOL.',
      fundingTermsAccepted: true,
      impressionTarget: 2000,
    });
    raidId = raid.id;
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db.$disconnect();
  });
  it('freezes quote and blocks activation until verified funding', async () => {
    const owner = await db.user.findUniqueOrThrow({ where: { id: ownerId } });
    const raid = await db.raid.findUniqueOrThrow({ where: { id: raidId } });
    expect(raid.mint).toBeNull();
    expect(raid.fundingLamports).toBe('2000000000');
    await expect(changeRaid(owner, raidId, 'launch')).rejects.toMatchObject({ status: 409 });
    await db.raid.update({
      where: { id: raidId },
      data: {
        fundingStatus: 'VERIFIED',
        fundingWallet: Keypair.generate().publicKey.toBase58(),
        status: 'ACTIVE',
        coverage: 'complete',
        startsAt: new Date(Date.now() - 60000),
        endsAt: new Date(Date.now() + 3600000),
      },
    });
  });
  it('ends Raid once qualified observed impressions reach target', async () => {
    const enrolled = await db.raidEnrollment.create({
      data: {
        raidId,
        userId: ownerId,
        xId: 'owner',
        walletAddress: Keypair.generate().publicKey.toBase58(),
      },
    });
    await db.post.create({
      data: {
        id: 'standalone-post-1',
        raidId,
        authorId: 'owner',
        enrollmentId: enrolled.id,
        text: 'test',
        normalized: 'test',
        createdAt: new Date(),
        observedAt: new Date(),
        likes: 1,
        views: 2000,
        qualification: 'QUALIFIED',
      },
    });
    await completeImpressionTarget(raidId);
    const raid = await db.raid.findUniqueOrThrow({ where: { id: raidId } });
    expect(raid.status).toBe('ENDED');
    expect(raid.targetReachedAt).not.toBeNull();
    expect(raid.trackingPhase).toBe('FINALIZING');
  });
  it('allocates only after reviewed result and preserves funding exactly', async () => {
    const now = new Date();
    const wallet = (await db.raidEnrollment.findFirstOrThrow({ where: { raidId } })).walletAddress;
    const raider = await db.user.create({ data: { xId: 'raider', handle: 'raider' } });
    const raiderWallet = Keypair.generate().publicKey.toBase58();
    const view = (authorId: string) => ({
      authorId,
      views: 1000,
      qualification: 'QUALIFIED',
      availability: 'AVAILABLE',
      reviewStatus: 'CLEAR',
      hidden: false,
      deleted: false,
    });
    const result = await db.campaignResult.create({
      data: {
        raidId,
        version: 1,
        fingerprint: 'fixture',
        payload: {
          participants: [
            { xId: 'owner', userId: ownerId, walletAddress: wallet },
            { xId: 'raider', userId: raider.id, walletAddress: raiderWallet },
          ],
          contributions: [view('owner'), view('raider')],
        },
      },
    });
    await db.raid.update({
      where: { id: raidId },
      data: {
        activeResultId: result.id,
        trackingPhase: 'APPROVED',
        reviewEndsAt: new Date(+now - 1),
      },
    });
    await allocateRaidFunding(raidId);
    await allocateRaidFunding(raidId);
    const allocations = await db.raidAllocation.findMany({ where: { raidId } });
    expect(allocations).toHaveLength(2);
    expect(allocations.reduce((sum, a) => sum + BigInt(a.lamports), 0n)).toBe(2_000_000_000n);
    expect(allocations.find((a) => a.kind === 'REWARD')?.lamports).toBe('1000000000');
    expect(allocations.find((a) => a.kind === 'REWARD')?.walletAddress).toBe(raiderWallet);
    expect(allocations.find((a) => a.kind === 'REFUND')?.lamports).toBe('1000000000');
  });
  it('refunds rewards below the minimum payout to the creator', async () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const raid = await db.raid.create({
      data: {
        tag: 'raid_min_payout',
        title: 'Minimum payout',
        description: '',
        fundingStatus: 'VERIFIED',
        fundingLamports: '1000000000',
        fundingRecipient: Keypair.generate().publicKey.toBase58(),
        fundingWallet: Keypair.generate().publicKey.toBase58(),
        impressionTarget: 1_000_000,
        authorCapBps: 2500,
        creatorId: ownerId,
        status: 'ENDED',
        trackingVersion: 2,
        trackingPhase: 'APPROVED',
        startsAt: new Date(Date.now() - 7200000),
        endsAt: new Date(Date.now() - 3600000),
      },
    });
    const users = await Promise.all(
      ['big', 'tiny'].map((xId) => db.user.create({ data: { xId, handle: xId } })),
    );
    const result = await db.campaignResult.create({
      data: {
        raidId: raid.id,
        version: 1,
        fingerprint: 'min-payout',
        payload: {
          participants: users.map((u) => ({
            xId: u.xId,
            userId: u.id,
            walletAddress: u.xId === 'big' ? wallet : Keypair.generate().publicKey.toBase58(),
          })),
          contributions: users.map((u) => ({
            authorId: u.xId,
            views: u.xId === 'big' ? 100_000 : 800,
            qualification: 'QUALIFIED',
            availability: 'AVAILABLE',
            reviewStatus: 'CLEAR',
            hidden: false,
            deleted: false,
          })),
        },
      },
    });
    await db.raid.update({ where: { id: raid.id }, data: { activeResultId: result.id } });
    await allocateRaidFunding(raid.id);
    const allocations = await db.raidAllocation.findMany({ where: { raidId: raid.id } });
    expect(allocations.filter((a) => a.kind === 'REWARD').map((a) => a.walletAddress)).toEqual([
      wallet,
    ]);
    expect(allocations.find((a) => a.kind === 'REWARD')?.lamports).toBe('100000000');
    expect(allocations.find((a) => a.kind === 'REFUND')?.lamports).toBe('900000000');
  });
  it('does not allocate while the settlement flag is off', async () => {
    vi.stubEnv('X_TRACKING_V2_SETTLEMENT_ENABLED', 'false');
    try {
      const raid = await db.raid.findFirstOrThrow({ where: { tag: 'raid_min_payout' } });
      await db.raidAllocation.deleteMany({ where: { raidId: raid.id } });
      await db.raid.update({ where: { id: raid.id }, data: { trackingPhase: 'APPROVED' } });
      await allocateRaidFunding(raid.id);
      expect(await db.raidAllocation.count({ where: { raidId: raid.id } })).toBe(0);
    } finally {
      vi.stubEnv('X_TRACKING_V2_SETTLEMENT_ENABLED', 'true');
    }
  });
});
