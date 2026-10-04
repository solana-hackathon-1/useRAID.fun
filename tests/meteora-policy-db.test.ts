import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { db } from '../src/lib/db';
import { config } from '../src/lib/config';
import {
  allocateLaunchCampaign,
  launchBalance,
  saveLaunchCampaign,
} from '../src/lib/meteora/campaigns';
import { schedule } from '../src/lib/worker-jobs';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

vi.mock('../src/lib/providers/x', () => ({
  lookupPosts: vi.fn(async (ids: string[]) => ({
    data: ids.map((id) => ({ id, text: 'Verified public target', author_id: 'project' })),
  })),
}));
const suite = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;

// Meteora campaigns run through the same money policies as every other funded Raid.
suite('Meteora campaigns under the shared money policies', () => {
  let owner: Awaited<ReturnType<typeof db.user.create>>;
  let launch: Awaited<ReturnType<typeof db.tokenLaunch.create>>;
  const input = {
    title: 'Policy raid',
    targetPosts: ['https://x.com/project/status/123456789'],
    impressionTarget: 1000,
    duration: 24,
    solBudget: '0.02',
    tokenBudget: '0',
    termsAccepted: true,
  };
  async function endedRaid(views: number[]) {
    const draft = await saveLaunchCampaign(launch.id, owner.id, input);
    await saveLaunchCampaign(launch.id, owner.id, { ...input, raidId: draft.id }, true);
    const participants = views.map((_, i) => ({
      enrollmentId: `e${i}`,
      userId: owner.id,
      xId: `raider-${draft.id}-${i}`,
      walletAddress: Keypair.generate().publicKey.toBase58(),
    }));
    const result = await db.campaignResult.create({
      data: {
        raidId: draft.id,
        version: 1,
        fingerprint: `policy-${draft.id}`,
        payload: {
          participants,
          contributions: views.map((v, i) => ({
            id: `p${i}`,
            enrollmentId: `e${i}`,
            authorId: participants[i].xId,
            views: v,
            qualification: 'QUALIFIED',
            availability: 'AVAILABLE',
            reviewStatus: 'CLEAR',
            hidden: false,
            deleted: false,
          })),
        },
      },
    });
    await db.raid.update({
      where: { id: draft.id },
      data: { status: 'ENDED', trackingPhase: 'APPROVED', activeResultId: result.id },
    });
    return draft.id;
  }
  async function topUp(key: string, units: bigint) {
    await db.launchBalanceEntry.create({
      data: {
        key,
        launchId: launch.id,
        network: 'devnet',
        asset: 'SOL',
        kind: 'FEE_RECEIPT',
        availableDelta: units,
        reservedDelta: 0n,
      },
    });
  }
  beforeAll(async () => {
    assertTestDatabase();
    await truncateAll(db);
    vi.stubEnv('METEORA_NETWORK', 'devnet');
    vi.stubEnv('X_BEARER_TOKEN', 'fixture');
    vi.stubEnv('METEORA_PAYOUT_ENABLED', 'true');
    vi.stubEnv('X_TRACKING_V2_SETTLEMENT_ENABLED', 'true');
    config.demo = false;
    config.liveApproved = true;
    await db.settings.create({ data: { collectionEnabled: true } });
    owner = await db.user.create({ data: { handle: 'policy-owner', xId: 'policy-owner' } });
    await db.xAccount.create({
      data: { userId: owner.id, xUserId: owner.xId!, username: owner.handle, displayName: 'Owner' },
    });
    launch = await db.tokenLaunch.create({
      data: {
        userId: owner.id,
        provider: 'METEORA',
        network: 'devnet',
        name: 'Policy launch',
        symbol: 'POL',
        mint: Keypair.generate().publicKey.toBase58(),
        feeAddress: Keypair.generate().publicKey.toBase58(),
        creatorAddress: Keypair.generate().publicKey.toBase58(),
        feeSecret: 'encrypted-fixture',
        mintSecret: 'encrypted-fixture',
        metadataUri: 'ipfs://fixture',
        imageUri: 'ipfs://fixture',
        description: 'Fixture',
        status: 'LIVE',
        workerObservedAt: new Date(),
      },
    });
    await db.token.create({
      data: { mint: launch.mint, name: launch.name, symbol: launch.symbol },
    });
    await topUp('policy-fees', 200_000_000n);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db.$disconnect();
  });

  it('allows the LAUNCH funding asset in the state CHECK and rejects other values', async () => {
    const draft = await saveLaunchCampaign(launch.id, owner.id, input);
    expect((await db.raid.findUniqueOrThrow({ where: { id: draft.id } })).fundingAsset).toBe(
      'LAUNCH',
    );
    await expect(
      db.raid.update({ where: { id: draft.id }, data: { fundingAsset: 'BOGUS' } }),
    ).rejects.toThrow(/Raid_fundingAsset_check/);
  });
  it('freezes the per-author cap at start and the guard keeps it frozen', async () => {
    const id = await endedRaid([500]);
    const raid = await db.raid.findUniqueOrThrow({ where: { id } });
    expect(raid.authorCapBps).toBe(2500);
    await expect(db.raid.update({ where: { id }, data: { authorCapBps: 10000 } })).rejects.toThrow(
      /frozen/,
    );
  });
  it('pauses allocation while settlement is off and resumes when it is on', async () => {
    const id = await endedRaid([500]);
    vi.stubEnv('X_TRACKING_V2_SETTLEMENT_ENABLED', 'false');
    await allocateLaunchCampaign(id);
    expect(await db.launchCampaignPayout.count({ where: { raidId: id } })).toBe(0);
    expect(
      (
        await db.launchCampaignBudget.findUniqueOrThrow({
          where: { raidId_asset: { raidId: id, asset: 'SOL' } },
        })
      ).status,
    ).toBe('RESERVED');
    vi.stubEnv('X_TRACKING_V2_SETTLEMENT_ENABLED', 'true');
    await allocateLaunchCampaign(id);
    expect(await db.launchCampaignPayout.count({ where: { raidId: id } })).toBe(1);
  });
  it('caps one author at 25% of the budget and returns the rest to the campaign balance', async () => {
    const before = await launchBalance(launch.id, 'SOL');
    const id = await endedRaid([1000]);
    await allocateLaunchCampaign(id);
    const payouts = await db.launchCampaignPayout.findMany({ where: { raidId: id } });
    expect(payouts.map((p) => p.units)).toEqual([5_000_000n]);
    const after = await launchBalance(launch.id, 'SOL');
    // 20M reserved at start; 5M stays reserved for the payout, 15M returns to available.
    expect(after.reserved - before.reserved).toBe(5_000_000n);
    expect(after.available - before.available).toBe(-5_000_000n);
  });
  it('refunds SOL rewards below the rent-exempt minimum instead of creating a payout', async () => {
    vi.stubEnv('SOL_MIN_PAYOUT_LAMPORTS', '6000000');
    const id = await endedRaid([1000]);
    await allocateLaunchCampaign(id);
    expect(await db.launchCampaignPayout.count({ where: { raidId: id } })).toBe(0);
    const budget = await db.launchCampaignBudget.findUniqueOrThrow({
      where: { raidId_asset: { raidId: id, asset: 'SOL' } },
    });
    expect(budget.status).toBe('ALLOCATED');
    expect(budget.earnedUnits).toBe(0n);
    vi.stubEnv('SOL_MIN_PAYOUT_LAMPORTS', '');
  });
  it('schedules Meteora jobs and settles ended LAUNCH raids without touching the Pump queue', async () => {
    const id = await endedRaid([200]);
    await db.raid.update({ where: { id }, data: { trackingPhase: 'APPROVED' } });
    await db.job.deleteMany();
    await schedule(new Date());
    const kinds = (await db.job.findMany()).map((j) => j.kind);
    expect(kinds).toContain('meteora-finance');
    expect(kinds).not.toContain('finance');
    expect(kinds).not.toContain('launch-reconcile');
    expect(await db.launchCampaignPayout.count({ where: { raidId: id } })).toBe(1);
  });
});
