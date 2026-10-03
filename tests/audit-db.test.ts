import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { db } from '../src/lib/db';
import { buildAuditReport } from '../src/lib/audit';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

const suite = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const counts = async () => ({
  entries: await db.balanceEntry.count(),
  transfers: await db.usdcTransfer.count(),
  allocations: await db.usdcAllocation.count(),
  raids: await db.raid.count(),
});

suite('tracking audit', () => {
  beforeAll(async () => {
    assertTestDatabase();
    await truncateAll(db);
    const user = await db.user.create({ data: { xId: 'audit-user', handle: 'audituser' } });
    const raid = await db.raid.create({
      data: {
        tag: 'raid_audit_studio',
        title: 'Audit studio',
        description: 'Audit studio raid',
        studioVersion: 1,
        fundingAsset: 'USDC',
        fundingNetwork: 'mainnet',
        poolUnits: 5_000_000n,
        creatorId: user.id,
        status: 'ACTIVE',
        startsAt: new Date(Date.now() - 3600000),
        endsAt: new Date(Date.now() + 3600000),
      },
    });
    const mint = 'So11111111111111111111111111111111111111112';
    await db.token.create({ data: { mint, symbol: 'SOL', name: 'SOL' } });
    await db.raid.create({
      data: {
        tag: 'raid_audit_legacy',
        title: 'Legacy SOL',
        description: 'Legacy SOL raid with a token',
        mint,
        fundingAsset: 'SOL',
        fundingStatus: 'FUNDED',
        creatorId: user.id,
        startsAt: new Date(Date.now() - 3600000),
        endsAt: new Date(Date.now() + 3600000),
      },
    });
    await db.balanceEntry.createMany({
      data: [
        {
          userId: user.id,
          key: 'audit-deposit',
          kind: 'DEPOSIT',
          availableDelta: 10_000_000n,
          reservedDelta: 0n,
        },
        {
          userId: user.id,
          key: 'audit-reserve',
          kind: 'RAID_RESERVE',
          availableDelta: -5_000_000n,
          reservedDelta: 5_000_000n,
        },
      ],
    });
    const base = {
      userId: user.id,
      walletAddress: 'wallet',
      recipient: 'recipient',
      network: 'mainnet',
      mint: 'mint',
    };
    const paidAllocation = await db.usdcAllocation.create({
      data: {
        raidId: raid.id,
        resultId: 'r1',
        userId: user.id,
        xId: 'x1',
        walletAddress: 'wallet',
        amount: 1_000_000n,
      },
    });
    const unpaidAllocation = await db.usdcAllocation.create({
      data: {
        raidId: raid.id,
        resultId: 'r1',
        userId: user.id,
        xId: 'x2',
        walletAddress: 'wallet',
        amount: 2_000_000n,
      },
    });
    await db.usdcTransfer.createMany({
      data: [
        {
          ...base,
          kind: 'REWARD',
          status: 'PAID',
          amount: 1_000_000n,
          allocationId: paidAllocation.id,
        },
        {
          ...base,
          kind: 'REWARD',
          status: 'REQUESTED',
          amount: 2_000_000n,
          allocationId: unpaidAllocation.id,
        },
      ],
    });
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it('reports USDC liabilities, unpaid allocations and studio pools without writing', async () => {
    const before = await counts();
    const report = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      return buildAuditReport(tx);
    });
    expect(await counts()).toEqual(before);
    expect(report.usdcBalances).toEqual([
      { network: 'mainnet', available: '5000000', reserved: '5000000' },
    ]);
    expect(report.usdcTransfers).toEqual(
      expect.arrayContaining([
        { network: 'mainnet', kind: 'REWARD', status: 'PAID', count: '1', amount: '1000000' },
        { network: 'mainnet', kind: 'REWARD', status: 'REQUESTED', count: '1', amount: '2000000' },
      ]),
    );
    expect(report.unpaidUsdcAllocations).toEqual([{ count: '1', amount: '2000000' }]);
    expect(report.studioRaids).toEqual([
      expect.objectContaining({
        fundingNetwork: 'mainnet',
        status: 'ACTIVE',
        count: '1',
        poolUnits: '5000000',
      }),
    ]);
  });

  it('counts legacy SOL raids that carry a token as standalone funding', async () => {
    const report = await db.$transaction((tx) => buildAuditReport(tx));
    expect(report.standaloneFunding).toEqual([
      expect.objectContaining({ fundingStatus: 'FUNDED', _count: 1 }),
    ]);
  });
});
