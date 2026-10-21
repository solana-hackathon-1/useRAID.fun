import { absorbAccount } from '../src/lib/account-merge';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { db } from '../src/lib/db';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
import {
  acquireAdvisories,
  acquireAccountRoots,
  advisoryKey,
  lockResource,
  requireIdentityLocks,
  replanIdentity,
  sealIdentityLocks,
  acquireIdentityChildren,
  type IdentityLockCapability,
} from '../src/identity-locks';
import { createPrismaIdentityTransaction } from '../src/lib/identity-storage-adapter';
import { prepareIdentity, identityWriter } from '../src/lib/identity-protocol';
import { ensureHumanParticipant } from '../src/identity-storage';
import { linkVerifiedWallet } from '../src/identity-link';
import { fixtureLinkInput, fixtureAddress } from './helpers/wallet-link-fixtures';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { sweepIdentityLeaves } from '../src/lib/identity-cleanup';

const suite = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
suite('shared lock protocol on PostgreSQL, independent ports and cleanup', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
  });
  afterAll(async () => {
    await truncateAll(db);
    await db.$disconnect();
  });
  it('shared advisory builder equals BOTH exclusivity triggers, preserving all registry key bytes', async () => {
    await db.user.create({ data: { id: 'alice', handle: 'test' } });
    const address = fixtureAddress(1);
    await db.$transaction(async (tx) => {
      const port = createPrismaIdentityTransaction(tx);
      const key = await advisoryKey(port, lockResource('wallet-subject', address));
      await tx.walletIdentity.create({ data: { address, userId: 'alice' } });
      const rows = await tx.$queryRaw<
        { key: string }[]
      >`SELECT (CASE WHEN classid::bigint >= 2147483648 THEN classid::bigint - 4294967296 ELSE classid::bigint END * 4294967296 + objid::bigint)::text AS key FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND objsubid=1`;
      expect(rows.map((r) => r.key)).toEqual([key]);
    });
    await db
      .$transaction(async (tx) => {
        const port = createPrismaIdentityTransaction(tx);
        const mapping = await ensureHumanParticipant(port, {
          accountId: 'alice',
          actorAccountId: 'alice',
          requestId: 'map',
        });
        // Raw trigger consumer in a fresh transaction below, without a helper-held advisory lock.
        return mapping.id;
      })
      .then(async (participantId) => {
        await db.$transaction(async (tx) => {
          const port = createPrismaIdentityTransaction(tx),
            address = fixtureAddress(2);
          const key = await advisoryKey(port, lockResource('wallet-subject', address));
          await tx.$executeRaw`INSERT INTO "WalletLink" ("accountId","participantId","networkIdentity","address","proofRef","linkActorAccountId","linkRequestId") VALUES ('alice',${participantId}::uuid,'mainnet',${address},'proof-trigger','alice','trigger')`;
          const [held] = await tx.$queryRaw<
            { count: number }[]
          >`SELECT count(*)::int AS count FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND objsubid=1 AND (CASE WHEN classid::bigint >= 2147483648 THEN classid::bigint - 4294967296 ELSE classid::bigint END * 4294967296 + objid::bigint)::text=${key}`;
          expect(held.count).toBe(1);
        });
      });
    await db.$transaction(async (tx) => {
      const port = createPrismaIdentityTransaction(tx);
      for (const kind of [
        'finance',
        'reward',
        'x-endpoint',
        'tracking',
        'post',
        'balance',
        'wallet-subject',
        'x-auth',
      ] as const) {
        const actual = await advisoryKey(port, lockResource(kind, 'synthetic'));
        const [expected] = await tx.$queryRaw<
          { key: string }[]
        >`SELECT hashtextextended(${`${kind}:synthetic`},0)::text AS key`;
        expect(actual).toBe(expected.key);
      }
    });
  });
  it('preplans sorted roots once and rejects late roots, upgrades, lower keys, forged/foreign/expired capabilities', async () => {
    await db.user.createMany({
      data: [
        { id: 'a', handle: 'a' },
        { id: 'z', handle: 'z' },
      ],
    });
    let stale!: IdentityLockCapability, ended!: ReturnType<typeof createPrismaIdentityTransaction>;
    await runCommandTransaction(db, async (_command, tx) => {
      const port = createPrismaIdentityTransaction(tx);
      await acquireAdvisories(port, [lockResource('balance', 'a')]);
      await expect(acquireAdvisories(port, [lockResource('tracking', 'a')])).rejects.toMatchObject({
        code: 'STORAGE_CONTRACT',
      });
      await acquireAccountRoots(port, [
        { id: 'z', mode: 'SHARE' },
        { id: 'a', mode: 'SHARE' },
      ]);
      await expect(acquireAccountRoots(port, [{ id: 'a', mode: 'UPDATE' }])).rejects.toMatchObject({
        code: 'STORAGE_CONTRACT',
      });
      await expect(
        acquireAccountRoots(port, [{ id: 'new', mode: 'KEY SHARE' }]),
      ).rejects.toMatchObject({ code: 'STORAGE_CONTRACT' });
      await acquireIdentityChildren(port, () => 'SHARE');
      const locks = await sealIdentityLocks(port);
      await expect(
        requireIdentityLocks(port, { version: 'v1' } as IdentityLockCapability),
      ).rejects.toMatchObject({ code: 'STORAGE_CONTRACT' });
      await expect(requireIdentityLocks({ ...port }, locks)).rejects.toMatchObject({
        code: 'STORAGE_CONTRACT',
      });
      await expect(
        requireIdentityLocks(port, locks, { accounts: [{ id: 'a', mode: 'UPDATE' }] }),
      ).rejects.toMatchObject({ code: 'STORAGE_CONTRACT' });
      stale = locks;
      ended = port;
    });
    await expect(requireIdentityLocks(ended, stale)).rejects.toMatchObject({
      code: 'STORAGE_CONTRACT',
    });
  });
  it('already-locked modules reuse the same transaction/root/subjects without upgrades and preserve provenance', async () => {
    await db.user.create({ data: { id: 'alice', handle: 'alice' } });
    await db.walletIdentity.create({ data: { userId: 'alice', address: fixtureAddress(1) } });
    await runCommandTransaction(db, async (_command, tx) => {
      const address = fixtureAddress(2),
        port = createPrismaIdentityTransaction(tx);
      const locks = await prepareIdentity(tx, {
        accounts: [{ id: 'alice', mode: 'NO KEY UPDATE' }],
        subjects: [address],
      });
      const first = await ensureHumanParticipant(port, {
        accountId: 'alice',
        actorAccountId: 'alice',
        requestId: 'original',
        locks,
      });
      const linked = await linkVerifiedWallet(port, {
        ...fixtureLinkInput('alice', address),
        locks,
      });
      expect(linked.participantId).toBe(first.id);
      expect(
        (await tx.participant.findUniqueOrThrow({ where: { accountId: 'alice' } }))
          .provisionRequestId,
      ).toBe('original');
      await expect(
        identityWriter(tx, locks).user.update({ where: { id: 'alice' }, data: { xId: 'new-key' } }),
      ).rejects.toMatchObject({ code: 'STORAGE_CONTRACT' });
    });
  });
  it('replans whole rolled-back transactions at most three times with stable operation ID; terminal FK errors propagate', async () => {
    let attempts = 0;
    await runCommandTransaction(db, async (_command, tx) => {
      await tx.walletChallenge.create({
        data: {
          digest: 'stable',
          address: 'fixture',
          message: 'fixture',
          expiresAt: new Date('2099-01-01'),
        },
      });
      if (++attempts < 3) replanIdentity();
    });
    expect(attempts).toBe(3);
    expect(await db.walletChallenge.count()).toBe(1);
    attempts = 0;
    await expect(
      runCommandTransaction(db, async () => {
        attempts++;
        replanIdentity();
      }),
    ).rejects.toMatchObject({ code: 'RETRY_TRANSACTION' });
    expect(attempts).toBe(3);
    attempts = 0;
    await expect(
      runCommandTransaction(db, async (_command, tx) => {
        attempts++;
        await tx.session.create({
          data: { tokenHash: 'missing', userId: 'absent', expiresAt: new Date('2099-01-01') },
        });
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    expect(attempts).toBe(1);
  });
  it('A3 retries neither terminal delete-FK denial nor an unrelated delete error, and preserves the latter object', async () => {
    await db.user.createMany({
      data: [
        { id: 'keep', handle: 'keep' },
        { id: 'drop', handle: 'drop' },
      ],
    });
    await db.$executeRawUnsafe(
      'CREATE TABLE protocol_a3_reference ("userId" text REFERENCES "User"(id) ON DELETE RESTRICT)',
    );
    try {
      await db.$executeRawUnsafe('INSERT INTO protocol_a3_reference VALUES ($1)', 'drop');
      let attempts = 0;
      await expect(
        runCommandTransaction(db, async (_port, tx) => {
          attempts++;
          await absorbAccount(tx, 'keep', 'drop');
        }),
      ).rejects.toMatchObject({
        status: 409,
        message: 'Only an activity-free account can be merged.',
      });
      expect(attempts).toBe(1);
      expect(await db.user.count()).toBe(2);
      expect(await db.moderationEvent.count()).toBe(0);
    } finally {
      await db.$executeRawUnsafe('DROP TABLE protocol_a3_reference');
    }
    const unrelated = Object.assign(new Error('unrelated fixture'), {
      code: 'P2010',
      meta: { code: '23514' },
    });
    let attempts = 0;
    await expect(
      runCommandTransaction(db, async (_port, tx) => {
        attempts++;
        const spy = vi.spyOn(tx.user, 'delete').mockRejectedValue(unrelated);
        try {
          await absorbAccount(tx, 'keep', 'drop');
        } finally {
          spy.mockRestore();
        }
      }),
    ).rejects.toBe(unrelated);
    expect(attempts).toBe(1);
  });
  it('cleanup leaf catalog has no incoming FKs or delete-side user triggers introducing later locks', async () => {
    for (const table of ['Session', 'OAuthAttempt', 'WalletChallenge']) {
      const [row] = await db.$queryRawUnsafe<{ incoming: number; triggers: number }[]>(
        `SELECT
        (SELECT count(*)::int FROM pg_constraint WHERE contype='f' AND confrelid=to_regclass($1)) AS incoming,
        (SELECT count(*)::int FROM pg_trigger WHERE tgrelid=to_regclass($1) AND NOT tgisinternal AND (tgtype & 8) <> 0) AS triggers`,
        `public."${table}"`,
      );
      expect(row, table).toEqual({ incoming: 0, triggers: 0 });
    }
  });
  it('sweeps at most 1000 leaves, skips a held row, and retains strict expiry boundaries until the next sweep', async () => {
    await db.user.create({ data: { id: 'alice', handle: 'test' } });
    const cutoff = new Date('2026-10-12T00:00:00Z');
    await db.session.createMany({
      data: Array.from({ length: 1002 }, (_, n) => ({
        tokenHash: `s-${String(n).padStart(4, '0')}`,
        userId: 'alice',
        expiresAt: n === 1001 ? cutoff : new Date(0),
      })),
    });
    const locker = new PrismaClient();
    let ready!: () => void, release!: () => void;
    const started = new Promise<void>((r) => {
        ready = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    const held = locker.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "tokenHash" FROM "Session" WHERE "tokenHash"='s-0000' FOR UPDATE`;
        ready();
        await gate;
      },
      { timeout: 10000 },
    );
    try {
      await started;
      expect(await sweepIdentityLeaves('Session', cutoff)).toBe(1000);
      expect(await db.session.count()).toBe(2);
      expect(await sweepIdentityLeaves('Session', cutoff)).toBe(0);
    } finally {
      release();
      await held;
      await locker.$disconnect();
    }
    expect(await sweepIdentityLeaves('Session', cutoff)).toBe(1);
    expect(await sweepIdentityLeaves('Session', cutoff, true)).toBe(1);
  });
});
