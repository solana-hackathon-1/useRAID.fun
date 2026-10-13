import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { ensureHumanParticipant, findHumanParticipant } from '../src/identity-storage';
import {
  createPrismaIdentityTransaction,
  classifyIdentityStorageFailure,
} from '../src/lib/identity-storage-adapter';
import { isEmptyAccount, absorbAccount } from '../src/lib/account-merge';
import { absorbLegacyAccount } from './helpers/legacy-account-merge';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
import { matchesBlockingObservation } from './helpers/lock-observation';
import { creditUsdc } from './helpers/ledger';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { createWalletChallenge, verifyWalletChallenge } from '../src/lib/wallet-auth';
import { config } from '../src/lib/config';
import { db as authDb } from '../src/lib/db';
import { hash } from '../src/lib/auth-primitives';

const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const db = new PrismaClient({ log: [] });
const options = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20000 };
const provision = (tx: Prisma.TransactionClient, accountId: string, requestId = 'request-1') =>
  ensureHumanParticipant(createPrismaIdentityTransaction(tx), {
    accountId,
    actorAccountId: accountId,
    requestId,
  });
const user = (id: string) => db.user.create({ data: { id, handle: id } });
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function pid(tx: Prisma.TransactionClient) {
  return (await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid'))[0].pid;
}
async function observeBlock(waiter: number, blocker: number, statement: RegExp) {
  expect(waiter).not.toBe(blocker);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const rows = await db.$queryRawUnsafe<{ query: string; blockers: number[] }[]>(
      'SELECT query, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid = $1',
      waiter,
    );
    if (matchesBlockingObservation(rows[0], blocker, statement)) {
      expect(rows[0].query).toMatch(statement);
      // Evidence comes from the DB lock graph, never from elapsed sleep.
      console.info(
        JSON.stringify({ storageRace: true, waiter, blocker, blockedStatement: rows[0].query }),
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('Expected independent PostgreSQL blocker was not observed');
}
async function authFixture(drop = 'drop') {
  await user('keep');
  await user(drop);
  await db.walletIdentity.create({ data: { address: 'synthetic-wallet', userId: drop } });
  await db.walletChallenge.create({
    data: {
      digest: 'proof',
      address: 'synthetic-wallet',
      message: 'synthetic-proof',
      userId: 'keep',
      expiresAt: new Date('2099-01-01'),
    },
  });
  await db.session.create({
    data: { tokenHash: 'old-session', userId: drop, expiresAt: new Date('2099-01-01') },
  });
  await db.oAuthAttempt.create({
    data: {
      stateHash: 'attempt',
      verifier: 'synthetic',
      userId: drop,
      expiresAt: new Date('2099-01-01'),
    },
  });
}
async function authSnapshot() {
  const tables = [
    'User',
    'WalletIdentity',
    'WalletChallenge',
    'Session',
    'OAuthAttempt',
    'XAccount',
    'ModerationEvent',
  ];
  const result: Record<string, unknown> = {};
  for (const table of tables)
    result[table] = await db.$queryRawUnsafe(
      `SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`,
    );
  return result;
}
async function legacyBusiness(tx: Prisma.TransactionClient) {
  await tx.walletChallenge.update({ where: { digest: 'proof' }, data: { consumedAt: new Date() } });
  await absorbLegacyAccount(tx, 'keep', 'drop');
  await tx.session.create({
    data: { tokenHash: 'new-session', userId: 'keep', expiresAt: new Date('2099-01-01') },
  });
}

integration('T006 actual additive database fences', () => {
  beforeAll(() => assertTestDatabase());
  beforeEach(() => truncateAll(db));
  afterAll(async () => {
    await truncateAll(db);
    await db.$disconnect();
    await authDb.$disconnect();
  });
  it('contains an enabled mapping mutation fence and validated restrictive User FK', async () => {
    // Semantic schema RED is an empty catalog observation, not a missing-relation error.
    const constraints = await db.$queryRawUnsafe<
      { conname: string; convalidated: boolean; confdeltype: string; confupdtype: string }[]
    >(
      `SELECT conname, convalidated, confdeltype::text, confupdtype::text FROM pg_constraint WHERE conrelid = to_regclass('public."Participant"')`,
    );
    expect(constraints).toContainEqual(
      expect.objectContaining({
        conname: 'Participant_accountId_fkey',
        convalidated: true,
        confdeltype: 'r',
        confupdtype: 'r',
      }),
    );
    const triggers = await db.$queryRawUnsafe<{ tgname: string; tgenabled: string }[]>(
      `SELECT tgname, tgenabled::text FROM pg_trigger WHERE tgrelid = to_regclass('public."Participant"') AND NOT tgisinternal`,
    );
    expect(triggers).toContainEqual({ tgname: 'participant_mapping_guard_v1', tgenabled: 'O' });
  });
  it('stable sequential retry keeps original ID/provenance and restricted reads', async () => {
    await user('alice');
    const first = await db.$transaction((tx) => provision(tx, 'alice', 'first'), options);
    const second = await db.$transaction((tx) => provision(tx, 'alice', 'second'), options);
    expect(second).toEqual(first);
    const rows = await db.$queryRawUnsafe<{ provisionRequestId: string }[]>(
      'SELECT "provisionRequestId" FROM "Participant"',
    );
    expect(rows).toEqual([{ provisionRequestId: 'first' }]);
    await db.user.update({ where: { id: 'alice' }, data: { suspended: true } });
    expect(
      await db.$transaction(
        (tx) => findHumanParticipant(createPrismaIdentityTransaction(tx), 'alice'),
        options,
      ),
    ).toEqual(first);
    await expect(db.$transaction((tx) => provision(tx, 'missing'), options)).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_FOUND',
    });
  });
  it('rejects deletion/key/provenance mutation while allowing profile and no-op updates', async () => {
    await user('alice');
    await db.$transaction((tx) => provision(tx, 'alice'), options);
    const before = await db.$queryRawUnsafe('SELECT to_jsonb(t) AS row FROM "Participant" t');
    for (const sql of [
      `DELETE FROM "User" WHERE id='alice'`,
      `UPDATE "User" SET id='renamed' WHERE id='alice'`,
      `DELETE FROM "Participant"`,
      `UPDATE "Participant" SET id=gen_random_uuid()`,
      `UPDATE "Participant" SET kind='AI_AGENT'`,
      `UPDATE "Participant" SET "accountId"='other'`,
      `UPDATE "Participant" SET "createdAt"='2000-01-01'`,
      `UPDATE "Participant" SET "provisionActorAccountId"='other'`,
      `UPDATE "Participant" SET "provisionRequestId"='changed'`,
    ])
      await expect(db.$executeRawUnsafe(sql)).rejects.toBeDefined();
    await db.$executeRawUnsafe('UPDATE "Participant" SET id=id');
    await db.user.update({ where: { id: 'alice' }, data: { handle: 'new display' } });
    expect(await db.$queryRawUnsafe('SELECT to_jsonb(t) AS row FROM "Participant" t')).toEqual(
      before,
    );
    expect(await db.user.findUnique({ where: { id: 'alice' } })).not.toBeNull();
  });
  it('new guard preserves both mapped accounts and all credential effects', async () => {
    await authFixture();
    await db.$transaction(async (tx) => {
      await provision(tx, 'keep');
      await provision(tx, 'drop');
    }, options);
    const before = await authSnapshot();
    expect(await db.$transaction((tx) => isEmptyAccount(tx, 'drop'), options)).toBe(false);
    await expect(
      db.$transaction(async (tx) => {
        await tx.walletChallenge.update({
          where: { digest: 'proof' },
          data: { consumedAt: new Date() },
        });
        await absorbAccount(tx, 'keep', 'drop');
      }, options),
    ).rejects.toThrow('Only an activity-free account');
    expect(await authSnapshot()).toEqual(before);
    expect(await db.$queryRawUnsafe('SELECT id FROM "Participant"')).toHaveLength(2);
  });
  it('allows genuine unmapped empty absorption into a mapped keeper; reverse denies', async () => {
    await authFixture();
    const mapping = await db.$transaction((tx) => provision(tx, 'keep'), options);
    await db.$transaction((tx) => absorbAccount(tx, 'keep', 'drop'), options);
    expect(
      await db.walletIdentity.findUnique({ where: { address: 'synthetic-wallet' } }),
    ).toMatchObject({ userId: 'keep' });
    expect(await db.user.findUnique({ where: { id: 'drop' } })).toBeNull();
    expect(
      await db.$transaction(
        (tx) => findHumanParticipant(createPrismaIdentityTransaction(tx), 'keep'),
        options,
      ),
    ).toEqual(mapping);
    await user('new');
    await expect(
      db.$transaction((tx) => absorbAccount(tx, 'new', 'keep'), options),
    ).rejects.toThrow('Only an activity-free account');
  });
  afterEach(() => {
    delete process.env.ACCOUNT_FOLDS_ENABLED;
  });
  it('verified wallet flow preserves mapped keeper and denies two mapped accounts without consuming proof', async () => {
    // The second half exercises the opt-in fold path; folding is gated off by default for launch.
    process.env.ACCOUNT_FOLDS_ENABLED = 'true';
    config.demo = false;
    config.appUrl = 'http://localhost:3000';
    const pair = Keypair.generate();
    const address = pair.publicKey.toBase58();
    const sign = (message: string) =>
      bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), pair.secretKey));
    await user('keep');
    await user('drop');
    await db.walletIdentity.create({ data: { address, userId: 'drop' } });
    const keeper = await db.$transaction((tx) => provision(tx, 'keep'), options);
    await db.$transaction((tx) => provision(tx, 'drop'), options);
    const rejected = await createWalletChallenge(address, 'keep');
    const before = await authSnapshot();
    await expect(
      verifyWalletChallenge(rejected.digest, sign(rejected.message), address, 'keep'),
    ).rejects.toMatchObject({ status: 409 });
    expect(await authSnapshot()).toEqual(before);
    // A fresh synthetic fixture verifies the existing allowed path, not canonical recovery.
    await truncateAll(db);
    await user('keep');
    await user('drop');
    await db.walletIdentity.create({ data: { address, userId: 'drop' } });
    const retained = await db.$transaction((tx) => provision(tx, 'keep'), options);
    const allowed = await createWalletChallenge(address, 'keep');
    const token = await verifyWalletChallenge(
      allowed.digest,
      sign(allowed.message),
      address,
      'keep',
    );
    expect(await db.session.findUnique({ where: { tokenHash: hash(token) } })).toMatchObject({
      userId: 'keep',
    });
    expect(await db.user.findUnique({ where: { id: 'drop' } })).toBeNull();
    expect(
      await db.$transaction(
        (tx) => findHumanParticipant(createPrismaIdentityTransaction(tx), 'keep'),
        options,
      ),
    ).toEqual(retained);
    expect(retained.id).not.toBe(keeper.id); // Separate deliberately reset test fixture.
  });
  it('retains exact synthetic financial/history rows and original monetary fences', async () => {
    await user('keep');
    await user('drop');
    await creditUsdc(db, 'drop', 'synthetic-history', 12000000n, 'sandbox');
    const raid = await db.raid.create({
      data: {
        tag: 'synthetic',
        title: 'synthetic',
        description: 'synthetic',
        creatorId: 'keep',
        startsAt: new Date('2099-01-01'),
        endsAt: new Date('2099-01-02'),
      },
    });
    await db.raidEnrollment.create({
      data: {
        raidId: raid.id,
        userId: 'drop',
        xId: 'synthetic-x',
        walletAddress: 'synthetic-destination',
      },
    });
    const snapshot = async () => {
      const result: Record<string, unknown> = {};
      for (const table of ['BalanceEntry', 'UsdcTransfer', 'RaidEnrollment'])
        result[table] = await db.$queryRawUnsafe(
          `SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`,
        );
      return result;
    };
    const before = await snapshot();
    await db.$transaction((tx) => provision(tx, 'drop'), options);
    await expect(
      db.$transaction((tx) => absorbAccount(tx, 'keep', 'drop'), options),
    ).rejects.toThrow('Only an activity-free account');
    await expect(db.user.delete({ where: { id: 'drop' } })).rejects.toBeDefined();
    await expect(
      db.balanceEntry.updateMany({ data: { availableDelta: 1n } }),
    ).rejects.toBeDefined();
    await expect(
      db.usdcTransfer.updateMany({ data: { recipient: 'redirected' } }),
    ).rejects.toBeDefined();
    expect(await snapshot()).toEqual(before);
  });
  it('provision wins against old binary at final DELETE; entire auth transaction rolls back', async () => {
    await authFixture();
    const before = await authSnapshot();
    const holding = deferred<number>();
    const release = deferred();
    const waiter = deferred<number>();
    const creation = db.$transaction(async (tx) => {
      const mapping = await provision(tx, 'drop');
      holding.resolve(await pid(tx));
      await release.promise;
      return mapping;
    }, options);
    const blocker = await holding.promise;
    const absorption = db
      .$transaction(async (tx) => {
        waiter.resolve(await pid(tx));
        await legacyBusiness(tx);
      }, options)
      .then(
        () => ({ ok: true, error: null }),
        (error: unknown) => ({ ok: false, error }),
      );
    try {
      await observeBlock(await waiter.promise, blocker, /DELETE FROM .*"User"/i);
    } finally {
      release.resolve();
    }
    const mapping = await creation;
    const outcome = await absorption;
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatchObject({ code: 'P2003' });
    expect(await authSnapshot()).toEqual(before);
    expect(
      await db.$transaction(
        (tx) => findHumanParticipant(createPrismaIdentityTransaction(tx), 'drop'),
        options,
      ),
    ).toEqual(mapping);
  }, 20000);
  it('delete wins: provision blocks on User key lock then denies missing account without orphan', async () => {
    await user('drop');
    const holding = deferred<number>();
    const release = deferred();
    const waiter = deferred<number>();
    const deletion = db.$transaction(async (tx) => {
      await tx.user.delete({ where: { id: 'drop' } });
      holding.resolve(await pid(tx));
      await release.promise;
    }, options);
    const blocker = await holding.promise;
    const creation = db
      .$transaction(async (tx) => {
        waiter.resolve(await pid(tx));
        return provision(tx, 'drop');
      }, options)
      .then(
        () => null,
        (error: unknown) => error,
      );
    try {
      await observeBlock(await waiter.promise, blocker, /FOR KEY SHARE/i);
    } finally {
      release.resolve();
    }
    await deletion;
    expect(await creation).toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
    expect(await db.$queryRawUnsafe('SELECT * FROM "Participant"')).toEqual([]);
  }, 20000);
  it('independent create/create race returns one committed identity and first provenance', async () => {
    await user('alice');
    const holding = deferred<number>();
    const release = deferred();
    const waiter = deferred<number>();
    const first = db.$transaction(async (tx) => {
      const mapping = await provision(tx, 'alice', 'first');
      holding.resolve(await pid(tx));
      await release.promise;
      return mapping;
    }, options);
    const blocker = await holding.promise;
    const second = db.$transaction(async (tx) => {
      waiter.resolve(await pid(tx));
      return provision(tx, 'alice', 'second');
    }, options);
    try {
      await observeBlock(await waiter.promise, blocker, /INSERT INTO "Participant"/i);
    } finally {
      release.resolve();
    }
    expect(await second).toEqual(await first);
    expect(await db.$queryRawUnsafe('SELECT "provisionRequestId" FROM "Participant"')).toEqual([
      { provisionRequestId: 'first' },
    ]);
  }, 20000);
  it.each(['40001', '40P01'])(
    'classifies actual PostgreSQL/Prisma %s and retries the whole callback',
    async (state) => {
      await user('alice');
      let attempts = 0;
      for (;;) {
        try {
          await db.$transaction(async (tx) => {
            attempts++;
            await provision(tx, 'alice', 'same-request');
            await tx.session.create({
              data: {
                tokenHash: 'same-session',
                userId: 'alice',
                expiresAt: new Date('2099-01-01'),
              },
            });
            if (attempts === 1)
              await tx.$executeRawUnsafe(
                `DO $$ BEGIN RAISE EXCEPTION 'synthetic retry' USING ERRCODE='${state}'; END $$`,
              );
          }, options);
          break;
        } catch (error) {
          const failure = classifyIdentityStorageFailure(error);
          expect(failure.code).toBe('RETRY_TRANSACTION');
          expect(await db.$queryRawUnsafe('SELECT * FROM "Participant"')).toEqual([]);
          expect(await db.session.count()).toBe(0);
          if (attempts >= 2) throw failure;
        }
      }
      expect(attempts).toBe(2);
      expect(await db.$queryRawUnsafe('SELECT "provisionRequestId" FROM "Participant"')).toEqual([
        { provisionRequestId: 'same-request' },
      ]);
      expect(await db.session.count()).toBe(1);
    },
  );
});
