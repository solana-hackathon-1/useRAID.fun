import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { db } from '../src/lib/db';
import { buildAuditReport } from '../src/lib/audit';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
import { creditUsdc } from './helpers/ledger';

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
        fundingStatus: 'VERIFIED',
        creatorId: user.id,
        startsAt: new Date(Date.now() - 3600000),
        endsAt: new Date(Date.now() + 3600000),
      },
    });
    await creditUsdc(db, user.id, 'audit-deposit', 10_000_000n);
    await db.balanceEntry.create({
      data: {
        userId: user.id,
        key: 'audit-reserve',
        raidId: raid.id,
        kind: 'RAID_RESERVED',
        availableDelta: -5_000_000n,
        reservedDelta: 5_000_000n,
      },
    });
    const base = {
      userId: user.id,
      walletAddress: 'wallet',
      recipient: 'recipient',
      network: 'mainnet',
      mint: 'mint',
    };
    const result = await db.campaignResult.create({
      data: { raidId: raid.id, version: 1, fingerprint: 'audit', payload: {} },
    });
    const paidAllocation = await db.usdcAllocation.create({
      data: {
        raidId: raid.id,
        resultId: result.id,
        userId: user.id,
        xId: 'x1',
        walletAddress: 'wallet',
        amount: 1_000_000n,
      },
    });
    const unpaidAllocation = await db.usdcAllocation.create({
      data: {
        raidId: raid.id,
        resultId: result.id,
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

  it('lists every stored state value and flags any outside the vocabulary', async () => {
    const report = await db.$transaction((tx) => buildAuditReport(tx));
    expect(report.states).toEqual(
      expect.arrayContaining([
        { table: 'Raid', column: 'status', value: 'ACTIVE', count: '1', allowed: true },
        { table: 'UsdcTransfer', column: 'kind', value: 'REWARD', count: '2', allowed: true },
      ]),
    );
    expect(report.unexpectedStates).toEqual([]);
    await db.$executeRaw`ALTER TABLE "Raid" DROP CONSTRAINT "Raid_status_check"`;
    try {
      await db.$executeRaw`UPDATE "Raid" SET "status" = 'LEGACY_ODD' WHERE "tag" = 'raid_audit_legacy'`;
      expect((await db.$transaction((tx) => buildAuditReport(tx))).unexpectedStates).toEqual([
        { table: 'Raid', column: 'status', value: 'LEGACY_ODD', count: '1', allowed: false },
      ]);
    } finally {
      await db.$executeRaw`UPDATE "Raid" SET "status" = 'ACTIVE' WHERE "tag" = 'raid_audit_legacy'`;
      await db.$executeRaw`ALTER TABLE "Raid" ADD CONSTRAINT "Raid_status_check" CHECK ("status" IN ('DRAFT','SCHEDULED','ACTIVE','ENDED')) NOT VALID`;
    }
  });
  it('counts legacy SOL raids that carry a token as standalone funding', async () => {
    const report = await db.$transaction((tx) => buildAuditReport(tx));
    expect(report.standaloneFunding).toEqual([
      expect.objectContaining({ fundingStatus: 'VERIFIED', _count: 1 }),
    ]);
  });
});
