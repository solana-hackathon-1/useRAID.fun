import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/lib/db';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
import { creditUsdc } from './helpers/ledger';

const suite = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;

suite('money integrity triggers', () => {
  let ownerId: string,
    raiderId: string,
    raidId: string,
    resultId: string,
    n = 0;
  const window = {
    startsAt: new Date(Date.now() - 3600000),
    endsAt: new Date(Date.now() + 3600000),
  };
  const newRaid = (extra: Record<string, unknown> = {}) =>
    db.raid.create({
      data: {
        tag: `raid_integrity_${++n}`,
        title: 'Integrity',
        description: 'Integrity fixture',
        creatorId: ownerId,
        status: 'ACTIVE',
        ...window,
        ...extra,
      },
    });
  const funded = (pool = 5_000_000n) =>
    newRaid({
      studioVersion: 1,
      fundingAsset: 'USDC',
      fundingStatus: 'VERIFIED',
      fundingNetwork: 'mainnet',
      poolUnits: pool,
      quoteRate: 1_000_000n,
      impressionTarget: 1000,
    });
  const reserve = (raid: string, pool: bigint, key = `reserve-${raid}`) =>
    db.balanceEntry.create({
      data: {
        key,
        userId: ownerId,
        raidId: raid,
        kind: 'RAID_RESERVED',
        availableDelta: -pool,
        reservedDelta: pool,
      },
    });
  const allocation = (raid: string, result: string, xId: string, amount: bigint) =>
    db.usdcAllocation.create({
      data: { raidId: raid, resultId: result, userId: raiderId, xId, walletAddress: 'w', amount },
    });
  const result = (raid: string, version = 1) =>
    db.campaignResult.create({
      data: { raidId: raid, version, fingerprint: `f${version}`, payload: {} },
    });

  beforeAll(() => assertTestDatabase());
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await truncateAll(db);
    ownerId = (await db.user.create({ data: { xId: 'owner', handle: 'owner', approved: true } }))
      .id;
    raiderId = (await db.user.create({ data: { xId: 'raider', handle: 'raider' } })).id;
    raidId = (await newRaid()).id;
    resultId = (await result(raidId)).id;
    await creditUsdc(db, ownerId, 'credit', 10_000_000n);
  });

  describe('append-only tables', () => {
    it('rejects every change to a moderation event', async () => {
      const event = await db.moderationEvent.create({
        data: { actorId: ownerId, action: 'x', targetId: 't', reason: 'r' },
      });
      await expect(
        db.moderationEvent.update({ where: { id: event.id }, data: { reason: 'edited' } }),
      ).rejects.toThrow(/append-only/);
      await expect(db.moderationEvent.delete({ where: { id: event.id } })).rejects.toThrow(
        /append-only/,
      );
    });
    it('rejects changing or deleting a USDC allocation', async () => {
      const a = await allocation(raidId, resultId, 'raider', 100n);
      await expect(
        db.usdcAllocation.update({ where: { id: a.id }, data: { amount: 200n } }),
      ).rejects.toThrow(/append-only/);
      await expect(db.usdcAllocation.delete({ where: { id: a.id } })).rejects.toThrow(
        /append-only/,
      );
    });
    it('rejects changing or deleting an enrollment, but allows a no-op upsert', async () => {
      const where = { raidId_xId: { raidId, xId: 'raider' } };
      const create = { raidId, userId: raiderId, xId: 'raider', walletAddress: 'w' };
      const row = await db.raidEnrollment.create({ data: create });
      await db.raidEnrollment.upsert({ where, create, update: {} });
      await expect(
        db.raidEnrollment.update({ where: { id: row.id }, data: { joinedAt: new Date(0) } }),
      ).rejects.toThrow(/append-only/);
      await expect(db.raidEnrollment.delete({ where: { id: row.id } })).rejects.toThrow(
        /append-only/,
      );
    });
  });

  describe('RaidAllocation', () => {
    const create = () =>
      db.raidAllocation.create({
        data: {
          raidId,
          resultId,
          kind: 'REWARD',
          xId: 'raider',
          walletAddress: 'w',
          lamports: '5',
        },
      });
    it('records a payment once and nothing else', async () => {
      const row = await create();
      await db.raidAllocation.update({
        where: { id: row.id },
        data: { signature: 'sig', paidAt: new Date() },
      });
      await expect(
        db.raidAllocation.update({ where: { id: row.id }, data: { signature: 'other' } }),
      ).rejects.toThrow(/immutable/);
      await expect(db.raidAllocation.delete({ where: { id: row.id } })).rejects.toThrow(
        /append-only/,
      );
    });
    it('rejects changing the amount before payment', async () => {
      const row = await create();
      await expect(
        db.raidAllocation.update({ where: { id: row.id }, data: { lamports: '6' } }),
      ).rejects.toThrow(/immutable/);
      await expect(
        db.raidAllocation.update({ where: { id: row.id }, data: { signature: 'sig' } }),
      ).rejects.toThrow(/immutable/);
    });
    it('links its result and allows a resultless refund', async () => {
      await db.raidAllocation.create({
        data: { raidId, resultId: null, kind: 'REFUND', walletAddress: 'w', lamports: '5' },
      });
      await expect(
        db.raidAllocation.create({
          data: { raidId, resultId: 'missing', kind: 'REWARD', walletAddress: 'w2', lamports: '5' },
        }),
      ).rejects.toThrow(/foreign key/i);
    });
  });

  describe('UsdcTransfer', () => {
    const transfer = (data: Record<string, unknown> = {}) =>
      db.usdcTransfer.create({
        data: {
          userId: ownerId,
          kind: 'WITHDRAWAL',
          amount: 100n,
          walletAddress: 'w',
          recipient: 'r',
          network: 'mainnet',
          mint: 'm',
          ...data,
        },
      });
    it('keeps identity fields fixed', async () => {
      const t = await transfer();
      await expect(
        db.usdcTransfer.update({ where: { id: t.id }, data: { amount: 1n } }),
      ).rejects.toThrow(/immutable/);
      await expect(
        db.usdcTransfer.update({ where: { id: t.id }, data: { walletAddress: 'x' } }),
      ).rejects.toThrow(/immutable/);
    });
    it('only moves forward and never edits a settled transfer', async () => {
      const t = await transfer();
      await db.usdcTransfer.update({
        where: { id: t.id },
        data: { status: 'PAID', signature: 's', paidAt: new Date() },
      });
      await expect(
        db.usdcTransfer.update({ where: { id: t.id }, data: { status: 'REQUESTED' } }),
      ).rejects.toThrow(/immutable/);
      await expect(
        db.usdcTransfer.update({ where: { id: t.id }, data: { signature: 'other' } }),
      ).rejects.toThrow(/immutable/);
      await expect(db.usdcTransfer.delete({ where: { id: t.id } })).rejects.toThrow(
        /unpaid deposit intent/,
      );
    });
    it('deletes only an unpaid deposit intent and enforces the vocabularies', async () => {
      const intent = await transfer({ kind: 'DEPOSIT', status: 'AWAITING_TRANSFER' });
      await db.usdcTransfer.delete({ where: { id: intent.id } });
      await expect(transfer({ status: 'BOGUS' })).rejects.toThrow(/UsdcTransfer_status_check/);
      await expect(transfer({ kind: 'BOGUS' })).rejects.toThrow(/UsdcTransfer_kind_check/);
    });
  });

  describe('Raid frozen fields', () => {
    it('freezes the funding terms once verified', async () => {
      const raid = await funded();
      for (const data of [
        { poolUnits: 1n },
        { quoteRate: 2n },
        { impressionTarget: 5 },
        { authorCapBps: 100 },
        { fundingRecipient: 'other' },
        { creatorId: raiderId },
      ])
        await expect(db.raid.update({ where: { id: raid.id }, data })).rejects.toThrow(/frozen/);
      await db.raid.update({ where: { id: raid.id }, data: { hidden: true, title: 'ok' } });
    });
    it('locks phase and result after settlement', async () => {
      const raid = await newRaid({ trackingPhase: 'APPROVED' });
      const first = await result(raid.id);
      const second = await result(raid.id, 2);
      await db.raid.update({ where: { id: raid.id }, data: { activeResultId: first.id } });
      await db.raid.update({ where: { id: raid.id }, data: { trackingPhase: 'ALLOCATED' } });
      await expect(
        db.raid.update({ where: { id: raid.id }, data: { activeResultId: second.id } }),
      ).rejects.toThrow(/settled Raid/);
      await expect(
        db.raid.update({ where: { id: raid.id }, data: { trackingPhase: 'APPROVED' } }),
      ).rejects.toThrow(/settled Raid/);
    });
    it('accepts only a newer result of the same Raid', async () => {
      const raid = await newRaid();
      const foreign = await result(raidId, 5);
      const first = await result(raid.id);
      await expect(
        db.raid.update({ where: { id: raid.id }, data: { activeResultId: foreign.id } }),
      ).rejects.toThrow(/newer result of the same Raid/);
      await db.raid.update({ where: { id: raid.id }, data: { activeResultId: first.id } });
      await expect(
        db.raid.update({ where: { id: raid.id }, data: { activeResultId: first.id } }),
      ).resolves.toBeTruthy();
      const older = await result(raid.id, 0);
      await expect(
        db.raid.update({ where: { id: raid.id }, data: { activeResultId: older.id } }),
      ).rejects.toThrow(/newer result of the same Raid/);
    });
  });

  describe('ledger conservation', () => {
    it('rejects an entry that would leave a negative balance, at commit', async () => {
      await expect(
        db.balanceEntry.create({
          data: {
            key: 'overdraw',
            userId: raiderId,
            kind: 'RAID_RESERVED',
            raidId: (await funded()).id,
            availableDelta: -1n,
            reservedDelta: 1n,
          },
        }),
      ).rejects.toThrow(/negative balance|pool/);
    });
    it('requires a reservation to equal the raid pool and to happen once', async () => {
      const raid = await funded(5_000_000n);
      await expect(reserve(raid.id, 4_000_000n)).rejects.toThrow(/exactly the pool/);
      await reserve(raid.id, 5_000_000n);
      await expect(reserve(raid.id, 5_000_000n, 'again')).rejects.toThrow();
    });
    it('requires a settlement to conserve the pool across allocations', async () => {
      const raid = await funded(5_000_000n);
      await reserve(raid.id, 5_000_000n);
      const r = await result(raid.id);
      await allocation(raid.id, r.id, 'raider', 1_000_000n);
      const settle = (available: bigint, key: string) =>
        db.balanceEntry.create({
          data: {
            key,
            userId: ownerId,
            raidId: raid.id,
            kind: 'RAID_SETTLED',
            availableDelta: available,
            reservedDelta: -5_000_000n,
          },
        });
      await expect(settle(5_000_000n, 'wrong')).rejects.toThrow(/does not conserve/);
      await settle(4_000_000n, 'right');
      await expect(
        db.balanceEntry.create({
          data: {
            key: 'release-after',
            userId: ownerId,
            raidId: raid.id,
            kind: 'RAID_RELEASED',
            availableDelta: 5_000_000n,
            reservedDelta: -5_000_000n,
          },
        }),
      ).rejects.toThrow();
    });
    it('releases a whole unallocated pool only', async () => {
      const raid = await funded(5_000_000n);
      await reserve(raid.id, 5_000_000n);
      const release = (available: bigint) =>
        db.balanceEntry.create({
          data: {
            key: `release-${available}`,
            userId: ownerId,
            raidId: raid.id,
            kind: 'RAID_RELEASED',
            availableDelta: available,
            reservedDelta: -5_000_000n,
          },
        });
      await expect(release(4_000_000n)).rejects.toThrow(/whole unallocated pool/);
      await release(5_000_000n);
    });
    it('rejects unknown kinds and sandbox-only kinds elsewhere', async () => {
      const entry = (data: Record<string, unknown>) =>
        db.balanceEntry.create({
          data: {
            userId: ownerId,
            availableDelta: 1n,
            reservedDelta: 0n,
            key: 'k',
            ...data,
          } as never,
        });
      await expect(entry({ kind: 'BOGUS' })).rejects.toThrow(/BalanceEntry_kind_check/);
      await expect(entry({ kind: 'TEST_FUNDS', network: 'mainnet' })).rejects.toThrow(
        /sandbox network/,
      );
      await entry({ kind: 'TEST_FUNDS', network: 'sandbox' });
    });
    it('allows a DEPOSIT without a transfer only on the sandbox network', async () => {
      const entry = (network: string) =>
        db.balanceEntry.create({
          data: {
            userId: ownerId,
            key: `d-${network}`,
            kind: 'DEPOSIT',
            network,
            availableDelta: 1n,
            reservedDelta: 0n,
          },
        });
      await expect(entry('mainnet')).rejects.toThrow(/requires a transfer/);
      await entry('sandbox');
    });
    it('ties transfer entries to the transfer amount, owner and network', async () => {
      const transfer = await db.usdcTransfer.create({
        data: {
          userId: ownerId,
          kind: 'WITHDRAWAL',
          amount: 1_000n,
          walletAddress: 'w',
          recipient: 'r',
          network: 'mainnet',
          mint: 'm',
        },
      });
      const reserved = (amount: bigint, userId = ownerId) =>
        db.balanceEntry.create({
          data: {
            key: `w-${amount}-${userId}`,
            userId,
            transferId: transfer.id,
            kind: 'WITHDRAWAL_RESERVED',
            availableDelta: -amount,
            reservedDelta: amount,
          },
        });
      await expect(reserved(999n)).rejects.toThrow(/does not match transfer/);
      await expect(reserved(1_000n, raiderId)).rejects.toThrow();
      await reserved(1_000n);
    });
    it('links entries to real raids and transfers', async () => {
      await expect(
        db.balanceEntry.create({
          data: {
            key: 'orphan',
            userId: ownerId,
            kind: 'DEPOSIT',
            transferId: 'missing',
            availableDelta: 1n,
            reservedDelta: 0n,
          },
        }),
      ).rejects.toThrow(/foreign key/i);
      await expect(
        db.usdcAllocation.create({
          data: {
            raidId,
            resultId: 'missing',
            userId: raiderId,
            xId: 'raider',
            walletAddress: 'w',
            amount: 1n,
          },
        }),
      ).rejects.toThrow(/foreign key/i);
    });
    it('keeps the ledger append-only', async () => {
      const entry = await db.balanceEntry.findFirstOrThrow();
      await expect(
        db.balanceEntry.update({ where: { id: entry.id }, data: { availableDelta: 1n } }),
      ).rejects.toThrow(/append-only/);
    });
  });

  describe('state checks', () => {
    it('rejects a new Raid state outside the vocabulary', async () => {
      await expect(
        db.$executeRaw`UPDATE "Raid" SET "status" = 'BOGUS' WHERE "id" = ${raidId}`,
      ).rejects.toThrow(/Raid_status_check/);
      await expect(
        db.$executeRaw`UPDATE "Raid" SET "trackingPhase" = 'BOGUS' WHERE "id" = ${raidId}`,
      ).rejects.toThrow(/Raid_trackingPhase_check/);
      await expect(
        db.$executeRaw`UPDATE "Raid" SET "fundingAsset" = 'EUR' WHERE "id" = ${raidId}`,
      ).rejects.toThrow(/Raid_fundingAsset_check/);
    });
    it('rejects a new Post state outside the vocabulary', async () => {
      await expect(
        db.post.create({
          data: {
            id: 'p1',
            raidId,
            authorId: 'a',
            text: 't',
            normalized: 't',
            createdAt: new Date(),
            observedAt: new Date(),
            qualification: 'BOGUS',
          },
        }),
      ).rejects.toThrow(/Post_qualification_check/);
    });
  });
});
