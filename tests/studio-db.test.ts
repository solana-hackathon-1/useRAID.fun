import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { db } from '../src/lib/db';
import { config } from '../src/lib/config';
import { saveStudioRaid, launchStudioRaid } from '../src/lib/studio-campaigns';
import { balance, requestWithdrawal, rejectWithdrawal } from '../src/lib/usdc';
import { allocateUsdcRaid } from '../src/lib/studio-finance';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
vi.mock('../src/lib/providers/x', () => ({
  lookupPosts: vi.fn(async (ids: string[]) => ({
    data: ids.map((id) => ({ id, text: 'Public target', author_id: 'project' })),
  })),
}));
const suite = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
suite('Studio atomic balances and settlement', () => {
  let owner: Awaited<ReturnType<typeof db.user.create>>, raidId: string;
  beforeAll(async () => {
    assertTestDatabase();
    await truncateAll(db);
    vi.stubEnv('USDC_MICROS_PER_1000_IMPRESSIONS', '1000000');
    vi.stubEnv('USDC_FUNDING_ADDRESS', Keypair.generate().publicKey.toBase58());
    vi.stubEnv('SOLANA_RPC_URL', 'https://example.invalid');
    vi.stubEnv('X_BEARER_TOKEN', 'fixture');
    config.demo = false;
    config.liveApproved = true;
    await db.settings.create({ data: { collectionEnabled: true } });
    owner = await db.user.create({
      data: { xId: 'studio-owner', handle: 'studio', approved: false },
    });
    await db.xAccount.create({
      data: {
        userId: owner.id,
        xUserId: owner.xId!,
        username: owner.handle,
        displayName: 'Studio',
      },
    });
    await db.walletIdentity.create({
      data: { userId: owner.id, address: Keypair.generate().publicKey.toBase58() },
    });
    await db.balanceEntry.create({
      data: {
        userId: owner.id,
        key: 'test-credit',
        kind: 'DEPOSIT',
        availableDelta: 10_000_000n,
        reservedDelta: 0n,
      },
    });
    raidId = (
      await saveStudioRaid(owner, {
        studioVersion: 1,
        projectType: 'PROJECT',
        title: 'Atomic Studio Raid',
        targetPosts: ['https://x.com/project/status/123456789'],
        impressionTarget: 2000,
        duration: 24,
      })
    ).id;
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db.$disconnect();
  });
  it('launch is self-serve and idempotent under concurrency', async () => {
    await Promise.all([
      launchStudioRaid(owner, raidId, '2000000', true),
      launchStudioRaid(owner, raidId, '2000000', true),
    ]);
    expect(await balance(owner.id)).toEqual({ available: 8_000_000n, reserved: 2_000_000n });
    expect(await db.balanceEntry.count({ where: { key: `raid-reserve:${raidId}` } })).toBe(1);
    expect((await db.raid.findUniqueOrThrow({ where: { id: raidId } })).status).toBe('ACTIVE');
  });
  it('withdrawal reserves only available funds, retry once; rejection releases once', async () => {
    const [a, b] = await Promise.all([
      requestWithdrawal(owner.id, 3_000_000n, 'withdrawal-test-000001'),
      requestWithdrawal(owner.id, 3_000_000n, 'withdrawal-test-000001'),
    ]);
    expect(a.id).toBe(b.id);
    expect((await balance(owner.id)).available).toBe(5_000_000n);
    await expect(
      requestWithdrawal(owner.id, 6_000_000n, 'withdrawal-test-000002'),
    ).rejects.toMatchObject({ status: 409 });
    await rejectWithdrawal(a.id, owner.id, 'Test operator rejection');
    await expect(rejectWithdrawal(a.id, owner.id, 'Again')).rejects.toMatchObject({ status: 409 });
    expect((await balance(owner.id)).available).toBe(8_000_000n);
  });
  it('network isolation and append-only ledger preserve funds', async () => {
    expect(await balance(owner.id, db, 'devnet')).toEqual({ available: 0n, reserved: 0n });
    await expect(
      db.balanceEntry.update({ where: { key: 'test-credit' }, data: { availableDelta: 0n } }),
    ).rejects.toThrow();
    await expect(requestWithdrawal(owner.id, -1n, 'withdrawal-test-000003')).rejects.toMatchObject({
      status: 400,
    });
  });
  it('settles reviewed partial impressions, refunds remainder exactly once', async () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const result = await db.campaignResult.create({
      data: {
        raidId,
        version: 1,
        fingerprint: 'studio-test',
        payload: {
          participants: [
            { enrollmentId: 'member', userId: owner.id, xId: owner.xId, walletAddress: wallet },
          ],
          contributions: [
            {
              id: 'post',
              enrollmentId: 'member',
              authorId: owner.xId,
              views: 1000,
              qualification: 'QUALIFIED',
              availability: 'AVAILABLE',
              reviewStatus: 'CLEAR',
              hidden: false,
              deleted: false,
            },
          ],
        },
      },
    });
    await db.raid.update({
      where: { id: raidId },
      data: { status: 'ENDED', trackingPhase: 'APPROVED', activeResultId: result.id },
    });
    await Promise.all([allocateUsdcRaid(raidId), allocateUsdcRaid(raidId)]);
    expect(await balance(owner.id)).toEqual({ available: 9_000_000n, reserved: 0n });
    const rewards = await db.usdcAllocation.findMany({ where: { raidId } });
    expect(rewards).toHaveLength(1);
    expect(rewards[0].amount).toBe(1_000_000n);
    expect(
      await db.usdcTransfer.count({
        where: { allocationId: rewards[0].id, status: 'REQUESTED', walletAddress: wallet },
      }),
    ).toBe(1);
  });
});
