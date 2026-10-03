import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { db } from '../src/lib/db';
import { config } from '../src/lib/config';
import { saveStudioRaid, launchStudioRaid } from '../src/lib/studio-campaigns';
import { balance, requestWithdrawal, rejectWithdrawal, createDeposit } from '../src/lib/usdc';
import { allocateUsdcRaid } from '../src/lib/studio-finance';
import { lookupPosts } from '../src/lib/providers/x';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
vi.mock('../src/lib/providers/x', () => ({
  lookupPosts: vi.fn(async (ids: string[]) => ({
    data: ids.map((id) => ({ id, text: 'Public target', author_id: 'project' })),
  })),
}));
vi.mock('../src/lib/usdc-chain', () => ({ findTransferPayment: vi.fn(async () => null) }));
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
    vi.stubEnv('X_TRACKING_V2_SETTLEMENT_ENABLED', 'true');
    config.demo = false;
    config.liveApproved = true;
    await db.settings.create({ data: { collectionEnabled: true } });
    owner = await db.user.create({
      data: { xId: 'studio-owner', handle: 'studio', approved: true },
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
    const launched = await db.raid.findUniqueOrThrow({ where: { id: raidId } });
    expect(launched.status).toBe('ACTIVE');
    expect(launched.authorCapBps).toBe(2500);
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
  it('caps one raider at the author share, excludes the creator and refunds the remainder once', async () => {
    const raider = await db.user.create({ data: { xId: 'studio-raider', handle: 'raider' } });
    const wallet = Keypair.generate().publicKey.toBase58();
    const result = await db.campaignResult.create({
      data: {
        raidId,
        version: 1,
        fingerprint: 'studio-test',
        payload: {
          participants: [
            { enrollmentId: 'member', userId: raider.id, xId: raider.xId, walletAddress: wallet },
            {
              enrollmentId: 'creator',
              userId: owner.id,
              xId: owner.xId,
              walletAddress: Keypair.generate().publicKey.toBase58(),
            },
          ],
          contributions: [
            ...[
              ['post', 'member', raider.xId, 1000],
              ['own-post', 'creator', owner.xId, 5000],
            ].map(([id, enrollmentId, authorId, views]) => ({
              id,
              enrollmentId,
              authorId,
              views,
              qualification: 'QUALIFIED',
              availability: 'AVAILABLE',
              reviewStatus: 'CLEAR',
              hidden: false,
              deleted: false,
            })),
          ],
        },
      },
    });
    await db.raid.update({
      where: { id: raidId },
      data: { status: 'ENDED', trackingPhase: 'APPROVED', activeResultId: result.id },
    });
    await Promise.all([allocateUsdcRaid(raidId), allocateUsdcRaid(raidId)]);
    expect(await balance(owner.id)).toEqual({ available: 9_500_000n, reserved: 0n });
    const rewards = await db.usdcAllocation.findMany({ where: { raidId } });
    expect(rewards).toHaveLength(1);
    expect(rewards[0].userId).toBe(raider.id);
    expect(rewards[0].amount).toBe(500_000n);
    expect(
      await db.usdcTransfer.count({
        where: { allocationId: rewards[0].id, status: 'REQUESTED', walletAddress: wallet },
      }),
    ).toBe(1);
  });

  it('credits dust rewards to the raider balance instead of the manual payout queue', async () => {
    const source = await db.raid.findUniqueOrThrow({ where: { id: raidId } });
    const { id: _id, fundingSignature: _signature, ...fields } = source;
    const [big, tiny] = await Promise.all(
      ['dust-big', 'dust-tiny'].map((xId) => db.user.create({ data: { xId, handle: xId } })),
    );
    const pool = 10_000_000n;
    const dust = await db.raid.create({
      data: {
        ...fields,
        tag: 'raid_dust_settlement',
        status: 'ENDED',
        trackingPhase: 'APPROVED',
        poolUnits: pool,
        impressionTarget: 10000,
        authorCapBps: 10000,
      },
    });
    await db.balanceEntry.create({
      data: {
        key: 'dust-reserve',
        userId: owner.id,
        raidId: dust.id,
        kind: 'RAID_RESERVED',
        availableDelta: 0n,
        reservedDelta: pool,
      },
    });
    const result = await db.campaignResult.create({
      data: {
        raidId: dust.id,
        version: 1,
        fingerprint: 'dust-test',
        payload: {
          participants: [big, tiny].map((u, i) => ({
            enrollmentId: `d${i}`,
            userId: u.id,
            xId: u.xId,
            walletAddress: Keypair.generate().publicKey.toBase58(),
          })),
          contributions: [big, tiny].map((u, i) => ({
            id: `dp${i}`,
            enrollmentId: `d${i}`,
            authorId: u.xId,
            views: i ? 5 : 9000,
            qualification: 'QUALIFIED',
            availability: 'AVAILABLE',
            reviewStatus: 'CLEAR',
            hidden: false,
            deleted: false,
          })),
        },
      },
    });
    await db.raid.update({ where: { id: dust.id }, data: { activeResultId: result.id } });
    const queued = await db.usdcTransfer.count({ where: { status: 'REQUESTED', kind: 'REWARD' } });
    await Promise.all([allocateUsdcRaid(dust.id), allocateUsdcRaid(dust.id)]);
    const credit = await db.usdcTransfer.findFirstOrThrow({
      where: { userId: tiny.id, kind: 'REWARD_CREDIT' },
    });
    expect(credit).toMatchObject({ status: 'PAID', amount: 5000n, signature: null });
    expect(await balance(tiny.id)).toEqual({ available: 5000n, reserved: 0n });
    expect(await db.balanceEntry.count({ where: { kind: 'RAID_REWARD_CREDIT' } })).toBe(1);
    expect(await db.usdcTransfer.count({ where: { userId: tiny.id, kind: 'REWARD' } })).toBe(0);
    expect(await db.usdcTransfer.count({ where: { status: 'REQUESTED', kind: 'REWARD' } })).toBe(
      queued + 1,
    );
    const allocations = await db.usdcAllocation.findMany({ where: { raidId: dust.id } });
    const settled = await db.balanceEntry.findUniqueOrThrow({
      where: { key: `raid-settle:${dust.id}` },
    });
    expect(allocations.reduce((sum, a) => sum + a.amount, 0n) + settled.availableDelta).toBe(pool);
  });

  it('does not settle while the settlement flag is off, except in the sandbox', async () => {
    vi.stubEnv('X_TRACKING_V2_SETTLEMENT_ENABLED', 'false');
    try {
      const draft = await saveStudioRaid(owner, {
        studioVersion: 1,
        projectType: 'PROJECT',
        title: 'Flag gated Raid',
        targetPosts: ['https://x.com/project/status/123456789'],
        impressionTarget: 1000,
        duration: 24,
      });
      await expect(launchStudioRaid(owner, draft.id, '1000000', true)).rejects.toMatchObject({
        status: 503,
      });
      const approved = await db.raid.create({
        data: {
          tag: 'raid_flag_off',
          title: 'Flag off',
          description: '',
          studioVersion: 1,
          fundingAsset: 'USDC',
          fundingNetwork: 'mainnet',
          fundingStatus: 'VERIFIED',
          fundingRecipient: 'recipient',
          poolUnits: 1_000_000n,
          impressionTarget: 1000,
          creatorId: owner.id,
          status: 'ENDED',
          trackingVersion: 2,
          trackingPhase: 'APPROVED',
          startsAt: new Date(),
          endsAt: new Date(),
        },
      });
      const result = await db.campaignResult.create({
        data: {
          raidId: approved.id,
          version: 1,
          fingerprint: 'flag-off',
          payload: { participants: [], contributions: [] },
        },
      });
      await db.raid.update({ where: { id: approved.id }, data: { activeResultId: result.id } });
      await allocateUsdcRaid(approved.id);
      expect(await db.balanceEntry.count({ where: { key: `raid-settle:${approved.id}` } })).toBe(0);
      expect((await db.raid.findUniqueOrThrow({ where: { id: approved.id } })).trackingPhase).toBe(
        'APPROVED',
      );
    } finally {
      vi.stubEnv('X_TRACKING_V2_SETTLEMENT_ENABLED', 'true');
    }
  });

  it('enforces minimum and open-request limits on deposits and withdrawals', async () => {
    await expect(
      requestWithdrawal(owner.id, 500_000n, 'withdrawal-min-000001'),
    ).rejects.toMatchObject({
      status: 400,
    });
    const keys = ['withdrawal-cap-000001', 'withdrawal-cap-000002', 'withdrawal-cap-000003'];
    const first = await requestWithdrawal(owner.id, 1_000_000n, keys[0]);
    await requestWithdrawal(owner.id, 1_000_000n, keys[1]);
    await requestWithdrawal(owner.id, 1_000_000n, keys[2]);
    await expect(
      requestWithdrawal(owner.id, 1_000_000n, 'withdrawal-cap-000004'),
    ).rejects.toMatchObject({
      status: 429,
    });
    expect((await requestWithdrawal(owner.id, 1_000_000n, keys[0])).id).toBe(first.id);
    await expect(createDeposit(owner.id, 999_999n)).rejects.toMatchObject({ status: 400 });
    for (const open of await db.usdcTransfer.findMany({
      where: { userId: owner.id, kind: 'WITHDRAWAL', status: 'REQUESTED' },
    }))
      await rejectWithdrawal(open.id, owner.id, 'Test cleanup');
    for (let i = 0; i < 3; i++) await createDeposit(owner.id, 1_000_000n).catch(() => undefined);
    await expect(createDeposit(owner.id, 1_000_000n)).rejects.toMatchObject({ status: 429 });
    await db.usdcTransfer.deleteMany({ where: { userId: owner.id, kind: 'DEPOSIT' } });
  });

  it('settles a large result with bulk allocation inserts and conserves the pool', async () => {
    const source = await db.raid.findUniqueOrThrow({ where: { id: raidId } });
    const { id: _id, fundingSignature: _signature, ...fields } = source;
    const count = 60;
    const users = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        db.user.create({ data: { xId: `bulk-${i}`, handle: `bulk${i}` } }),
      ),
    );
    const pool = 60_000_000n;
    const bulk = await db.raid.create({
      data: {
        ...fields,
        tag: 'raid_bulk_settlement',
        status: 'ENDED',
        trackingPhase: 'APPROVED',
        poolUnits: pool,
        impressionTarget: 60000,
      },
    });
    await db.balanceEntry.create({
      data: {
        key: 'bulk-reserve',
        userId: owner.id,
        raidId: bulk.id,
        kind: 'RAID_RESERVED',
        availableDelta: 0n,
        reservedDelta: pool,
      },
    });
    const result = await db.campaignResult.create({
      data: {
        raidId: bulk.id,
        version: 1,
        fingerprint: 'bulk-test',
        payload: {
          participants: users.map((u, i) => ({
            enrollmentId: `e${i}`,
            userId: u.id,
            xId: u.xId,
            walletAddress: Keypair.generate().publicKey.toBase58(),
          })),
          contributions: users.map((u, i) => ({
            id: `p${i}`,
            enrollmentId: `e${i}`,
            authorId: u.xId,
            views: 1000,
            qualification: 'QUALIFIED',
            availability: 'AVAILABLE',
            reviewStatus: 'CLEAR',
            hidden: false,
            deleted: false,
          })),
        },
      },
    });
    await db.raid.update({ where: { id: bulk.id }, data: { activeResultId: result.id } });
    await allocateUsdcRaid(bulk.id);
    await allocateUsdcRaid(bulk.id);
    const allocations = await db.usdcAllocation.findMany({ where: { raidId: bulk.id } });
    expect(allocations).toHaveLength(count);
    expect(
      await db.usdcTransfer.count({
        where: { allocationId: { in: allocations.map((a) => a.id) }, kind: 'REWARD' },
      }),
    ).toBe(count);
    const settled = await db.balanceEntry.findUniqueOrThrow({
      where: { key: `raid-settle:${bulk.id}` },
    });
    expect(allocations.reduce((sum, a) => sum + a.amount, 0n) + settled.availableDelta).toBe(pool);
    expect((await db.raid.findUniqueOrThrow({ where: { id: bulk.id } })).trackingPhase).toBe(
      'ALLOCATED',
    );
  });

  it('keeps studio money rows bound to their user and raid with RESTRICT foreign keys', async () => {
    const rules = await db.$queryRaw<{ name: string; del: string; upd: string }[]>`
      SELECT conname AS name, confdeltype::text AS del, confupdtype::text AS upd
      FROM pg_constraint
      WHERE conname IN (
        'BalanceEntry_userId_fkey',
        'UsdcTransfer_userId_fkey',
        'UsdcAllocation_raidId_fkey',
        'UsdcAllocation_userId_fkey'
      )
      ORDER BY conname`;
    expect(rules.map((rule) => rule.name)).toEqual([
      'BalanceEntry_userId_fkey',
      'UsdcAllocation_raidId_fkey',
      'UsdcAllocation_userId_fkey',
      'UsdcTransfer_userId_fkey',
    ]);
    for (const rule of rules) expect([rule.del, rule.upd]).toEqual(['r', 'c']);

    const holder = await db.user.create({ data: { xId: 'fk-holder', handle: 'fk-holder' } });
    await db.balanceEntry.create({
      data: {
        userId: holder.id,
        key: 'fk-credit',
        kind: 'DEPOSIT',
        availableDelta: 1n,
        reservedDelta: 0n,
      },
    });
    await db.usdcTransfer.create({
      data: {
        userId: holder.id,
        kind: 'WITHDRAWAL',
        amount: 1n,
        walletAddress: 'w',
        recipient: 'w',
        network: 'sandbox',
        mint: 'm',
      },
    });
    await expect(db.user.delete({ where: { id: holder.id } })).rejects.toMatchObject({
      code: 'P2003',
    });
    await expect(
      db.usdcAllocation.create({
        data: {
          raidId,
          resultId: 'fk-result',
          userId: 'missing-user',
          xId: 'fk-x',
          walletAddress: 'w',
          amount: 1n,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  describe('creator approval and bounded X lookups', () => {
    const draft = (targets: string[]) => ({
      studioVersion: 1,
      projectType: 'PROJECT',
      title: 'Lookup bounded Raid',
      targetPosts: targets.map((id) => `https://x.com/project/status/${id}`),
      impressionTarget: 2000,
      duration: 24,
    });
    const creator = async (xId: string, approved: boolean) => {
      const user = await db.user.create({ data: { xId, handle: xId, approved } });
      await db.xAccount.create({
        data: { userId: user.id, xUserId: xId, username: xId, displayName: xId },
      });
      return user;
    };
    it('refuses drafts and launches from unapproved creators', async () => {
      const stranger = await creator('unapproved-user', false);
      await expect(saveStudioRaid(stranger, draft(['111111111']))).rejects.toMatchObject({
        status: 403,
      });
      expect(await db.raid.count({ where: { creatorId: stranger.id } })).toBe(0);
      const saved = await saveStudioRaid(owner, draft(['111111112']));
      await db.user.update({ where: { id: owner.id }, data: { approved: false } });
      try {
        const revoked = await db.user.findUniqueOrThrow({ where: { id: owner.id } });
        await expect(saveStudioRaid(revoked, draft(['111111112']), saved.id)).rejects.toMatchObject(
          { status: 403 },
        );
        await expect(launchStudioRaid(revoked, saved.id, '2000000', true)).rejects.toMatchObject({
          status: 403,
        });
      } finally {
        await db.user.update({ where: { id: owner.id }, data: { approved: true } });
      }
    });
    it('reuses fresh previews and looks up only new targets', async () => {
      const lookups = vi.mocked(lookupPosts);
      lookups.mockClear();
      const user = await creator('lookup-user', true);
      const saved = await saveStudioRaid(user, draft(['211111111', '211111112']));
      expect(lookups).toHaveBeenCalledTimes(1);
      expect(lookups.mock.calls[0][0]).toEqual(['211111111', '211111112']);
      const stamp = async () =>
        (
          await db.raidBriefPost.findMany({
            where: { raidId: saved.id },
            orderBy: { postId: 'asc' },
          })
        ).map((p) => p.validatedAt?.toISOString());
      const before = await stamp();
      expect(before.every(Boolean)).toBe(true);
      await saveStudioRaid(user, draft(['211111111', '211111112']), saved.id);
      expect(lookups).toHaveBeenCalledTimes(1);
      expect(await stamp()).toEqual(before);
      await saveStudioRaid(user, draft(['211111111', '211111112', '211111113']), saved.id);
      expect(lookups).toHaveBeenCalledTimes(2);
      expect(lookups.mock.calls[1][0]).toEqual(['211111113']);
    });
    it('keeps links without lookups once the daily quota is spent', async () => {
      const lookups = vi.mocked(lookupPosts);
      vi.stubEnv('STUDIO_LOOKUPS_PER_DAY', '1');
      try {
        const user = await creator('quota-user', true);
        lookups.mockClear();
        const saved = await saveStudioRaid(user, draft(['311111111', '311111112']));
        expect(lookups).not.toHaveBeenCalled();
        const rows = await db.raidBriefPost.findMany({ where: { raidId: saved.id } });
        expect(rows).toHaveLength(2);
        expect(rows.every((r) => r.validatedAt === null)).toBe(true);
      } finally {
        vi.stubEnv('STUDIO_LOOKUPS_PER_DAY', '300');
      }
    });
    it('saves 100 targets in one pass and preserves previews on re-save', async () => {
      const user = await creator('bulk-targets-user', true);
      const ids = Array.from({ length: 100 }, (_, i) => `${400000000 + i}`);
      const saved = await saveStudioRaid(user, draft(ids));
      expect(await db.raidBriefPost.count({ where: { raidId: saved.id } })).toBe(100);
      await saveStudioRaid(user, draft(ids.slice(0, 60)), saved.id);
      const rows = await db.raidBriefPost.findMany({ where: { raidId: saved.id } });
      expect(rows).toHaveLength(60);
      expect(rows.every((r) => r.preview && r.validatedAt)).toBe(true);
    });
    it('spends no lookups launching while the platform is not ready', async () => {
      const user = await creator('not-ready-user', true);
      const saved = await saveStudioRaid(user, draft(['511111111']));
      vi.mocked(lookupPosts).mockClear();
      await db.settings.update({ where: { id: 'global' }, data: { collectionEnabled: false } });
      try {
        await expect(launchStudioRaid(user, saved.id, '2000000', true)).rejects.toMatchObject({
          status: 503,
        });
        expect(lookupPosts).not.toHaveBeenCalled();
      } finally {
        await db.settings.update({ where: { id: 'global' }, data: { collectionEnabled: true } });
      }
    });
  });
});
