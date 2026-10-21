import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { db } from '../src/lib/db';
import { config } from '../src/lib/config';
import { createWalletChallenge, verifyWalletChallenge } from '../src/lib/wallet-auth';
import { absorbAccount } from '../src/lib/account-merge';
import { allocateUsdcRaid } from '../src/lib/studio-finance';
import { hash } from '../src/lib/auth-primitives';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
import { creditUsdc } from './helpers/ledger';

// Ordering regressions must not be made green by the host's deadlock retry.
vi.mock('../src/lib/command-receipts-adapter', async (original) => {
  const m = await original<typeof import('../src/lib/command-receipts-adapter')>();
  return {
    ...m,
    runCommandTransaction: (
      client: Parameters<typeof m.runCommandTransaction>[0],
      work: Parameters<typeof m.runCommandTransaction>[1],
    ) => m.runCommandTransaction(client, work, { maxAttempts: 1 }),
  };
});
const suite = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const observer = new PrismaClient();
const locker = new PrismaClient({ transactionOptions: { timeout: 15000 } });
const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};
const settle = (p: Promise<unknown>) =>
  p.then(
    () => ({ ok: true }),
    (error: unknown) => ({ ok: false, error }),
  );
async function waitForWait(needle = '') {
  const until = Date.now() + 4000;
  while (Date.now() < until) {
    const rows = await observer.$queryRaw<{ pid: number; blockers: number[]; query: string }[]>`
      SELECT pid, pg_blocking_pids(pid) AS blockers, query FROM pg_stat_activity
      WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid)) > 0`;
    const matching = rows.filter((row) => row.query.includes(needle));
    if (matching.length) {
      // Only statement shape, no signed bytes/token/bindings in the retained trace.
      console.info(
        JSON.stringify({
          waitTrace: matching.map(({ pid, blockers, query }) => ({
            pid,
            blockers,
            table: query.includes('Session')
              ? 'Session'
              : query.includes('User')
                ? 'User'
                : 'advisory',
          })),
        }),
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('Required backend wait not observed');
}
const transactionErrors: unknown[] = [];
function intercept(
  work: (
    tx: Prisma.TransactionClient,
    model: string,
    method: string,
    args: unknown[],
  ) => Promise<void>,
) {
  const transaction = db.$transaction.bind(db);
  vi.spyOn(db, '$transaction').mockImplementation((async (
    callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
    options: object,
  ) =>
    transaction(
      async (tx) =>
        callback(
          new Proxy(tx, {
            get(target, property) {
              const value = Reflect.get(target, property);
              if (
                typeof property === 'string' &&
                property.startsWith('$') &&
                typeof value === 'function'
              )
                return async (...args: unknown[]) => {
                  await work(tx, '$', property, args);
                  return value.apply(target, args);
                };
              if (typeof value === 'object' && value !== null)
                return new Proxy(value, {
                  get(delegate, method) {
                    const fn = Reflect.get(delegate, method);
                    return typeof fn === 'function'
                      ? async (...args: unknown[]) => {
                          await work(tx, String(property), String(method), args);
                          return fn.apply(delegate, args);
                        }
                      : fn;
                  },
                });
              return value;
            },
          }),
        ),
      options,
    ).catch((error: unknown) => {
      transactionErrors.push(error);
      throw error;
    })) as typeof db.$transaction);
}

async function financeFixture() {
  const creator = await db.user.create({ data: { id: 'm-owner', handle: 'creator' } });
  await db.user.createMany({
    data: [
      { id: 'a-member', handle: 'lo' },
      { id: 'z-member', handle: 'hi' },
    ],
  });
  await creditUsdc(db, creator.id, 'protocol-funds', 10000000n);
  const raid = await db.raid.create({
    data: {
      tag: 'protocol-finance',
      title: 'Fixture',
      description: 'Synthetic',
      creatorId: creator.id,
      startsAt: new Date(0),
      endsAt: new Date(1),
      studioVersion: 1,
      poolUnits: 10000000n,
      impressionTarget: 1000,
      fundingStatus: 'VERIFIED',
      fundingRecipient: 'fixture-recipient',
      trackingPhase: 'APPROVED',
      authorCapBps: 5000,
    },
  });
  const result = await db.campaignResult.create({
    data: {
      raidId: raid.id,
      version: 1,
      fingerprint: 'protocol',
      payload: {
        participants: ['z-member', 'a-member'].map((id) => ({
          userId: id,
          xId: id,
          walletAddress: 'fixture-' + id,
          enrollmentId: id,
        })),
        contributions: ['z-member', 'a-member'].map((id) => ({
          id,
          enrollmentId: id,
          authorId: id,
          views: 500,
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
  await db.balanceEntry.create({
    data: {
      key: 'raid-reserve:' + raid.id,
      userId: creator.id,
      raidId: raid.id,
      kind: 'RAID_RESERVED',
      network: 'mainnet',
      availableDelta: -10000000n,
      reservedDelta: 10000000n,
    },
  });
  return { creator, raid };
}

suite('approved identity protocol: real PostgreSQL/application schedules', () => {
  beforeAll(() => {
    assertTestDatabase();
    config.demo = false;
    config.appUrl = 'http://localhost:3000';
    vi.stubEnv('WALLET_LINKS_ENABLED', 'false');
    vi.stubEnv('ACCOUNT_FOLDS_ENABLED', 'false');
    vi.stubEnv('X_TRACKING_V2_SETTLEMENT_ENABLED', 'true');
  });
  beforeEach(async () => {
    transactionErrors.length = 0;
    await db.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS zz_protocol_finance_pause ON "UsdcAllocation"',
    );
    await truncateAll(db);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await Promise.all([db.$disconnect(), observer.$disconnect(), locker.$disconnect()]);
  });

  it.each(['writerFirst', 'mergeFirst'])(
    'X1 actual wallet session replacement vs strong root, %s',
    async (order) => {
      const kp = Keypair.generate(),
        address = kp.publicKey.toBase58();
      const user = await db.user.create({ data: { handle: 'protocol-wallet' } });
      await db.walletIdentity.create({ data: { userId: user.id, address } });
      const old = hash('protocol-old');
      await db.session.create({
        data: {
          userId: user.id,
          tokenHash: old,
          via: 'wallet',
          expiresAt: new Date(Date.now() + 60000),
        },
      });
      const c = await createWalletChallenge(address);
      const signature = bs58.encode(
        nacl.sign.detached(new TextEncoder().encode(c.message), kp.secretKey),
      );
      const replacing = gate(),
        releaseWriter = gate(),
        rooted = gate(),
        releaseMerge = gate();
      const errors: unknown[] = [];
      intercept(async (_tx, model, method) => {
        if (model === 'session' && method === 'create') {
          replacing.open();
          await releaseWriter.promise;
        }
      });
      const merge = () =>
        locker
          .$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM "User" WHERE id=${user.id} FOR UPDATE`;
            rooted.open();
            if (order === 'mergeFirst') await releaseMerge.promise;
            await tx.session.deleteMany({ where: { userId: user.id } });
            await tx.user.delete({ where: { id: user.id } });
          })
          .catch((e: unknown) => {
            errors.push(e);
            throw e;
          });
      let m: ReturnType<typeof settle>;
      if (order === 'mergeFirst') {
        m = settle(merge());
        await rooted.promise;
      }
      const w = settle(verifyWalletChallenge(c.digest, signature, address, undefined, old));
      try {
        if (order === 'writerFirst') {
          await replacing.promise;
          m = settle(merge());
          await waitForWait();
        } else {
          await Promise.race([replacing.promise, waitForWait()]);
          releaseMerge.open();
        }
        releaseWriter.open();
        const [writer, merged] = await Promise.all([w, m!]);
        expect(
          transactionErrors.filter(
            (e) => String(e).includes('40P01') || (e as { code?: string }).code === 'P2034',
          ),
        ).toEqual([]);
        expect(errors).toEqual([]);
        expect(merged.ok).toBe(true);
        if (order === 'writerFirst') expect(writer.ok).toBe(true);
        else if (!writer.ok)
          expect('error' in writer ? writer.error : undefined).toMatchObject({
            status: expect.any(Number),
          });
        expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
      } finally {
        releaseMerge.open();
        releaseWriter.open();
        await Promise.allSettled([w, m!]);
      }
    },
    15000,
  );

  it('SHARE serializes account restriction with actual sign-in issuance', async () => {
    const kp = Keypair.generate(),
      address = kp.publicKey.toBase58();
    const user = await db.user.create({ data: { handle: 'suspension' } });
    await db.walletIdentity.create({ data: { userId: user.id, address } });
    const c = await createWalletChallenge(address);
    const paused = gate(),
      release = gate();
    intercept(async (_tx, model, method) => {
      if (model === 'session' && method === 'create') {
        paused.open();
        await release.promise;
      }
    });
    const sign = settle(
      verifyWalletChallenge(
        c.digest,
        bs58.encode(nacl.sign.detached(new TextEncoder().encode(c.message), kp.secretKey)),
        address,
      ),
    );
    await paused.promise;
    let suspensionDone = false;
    const suspension = locker
      .$transaction(async (tx) => {
        await tx.user.update({ where: { id: user.id }, data: { suspended: true } });
        await tx.session.deleteMany({ where: { userId: user.id } });
      })
      .then(() => {
        suspensionDone = true;
      });
    try {
      await Promise.race([waitForWait(), suspension]);
      expect(suspensionDone).toBe(false);
    } finally {
      release.open();
      await Promise.all([sign, suspension]);
    }
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
  }, 15000);

  it.each(['writerFirst', 'mergeFirst'])(
    'A2/X2 real allocateUsdcRaid with non-credit users in reverse order, %s',
    async (order) => {
      const { raid } = await financeFixture();
      // AFTER trigger ordered after RI constraint check: pauses the real bulk SQL after its first
      // User FK check; the original createMany, createManyAndReturn and amounts remain untouched.
      await db.$executeRawUnsafe(
        `CREATE OR REPLACE FUNCTION protocol_finance_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."userId"='z-member' THEN PERFORM pg_advisory_xact_lock(880012); END IF; RETURN NEW; END $$`,
      );
      await db.$executeRawUnsafe(
        `CREATE TRIGGER zz_protocol_finance_pause AFTER INSERT ON "UsdcAllocation" FOR EACH ROW EXECUTE FUNCTION protocol_finance_pause()`,
      );
      const blocked = gate(),
        release = gate(),
        loHeld = gate(),
        mergeContinue = gate();
      const hold = locker.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(880012)`;
        blocked.open();
        await release.promise;
      });
      await blocked.promise;
      const roots = () =>
        observer.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM "User" WHERE id='a-member' FOR UPDATE`;
            loHeld.open();
            if (order === 'mergeFirst') await mergeContinue.promise;
            await tx.$queryRaw`SELECT id FROM "User" WHERE id='z-member' FOR UPDATE`;
          },
          { timeout: 15000 },
        );
      let merge: ReturnType<typeof settle>;
      if (order === 'mergeFirst') {
        merge = settle(roots());
        await loHeld.promise;
      }
      const finance = settle(allocateUsdcRaid(raid.id));
      try {
        await waitForWait();
        if (order === 'writerFirst') {
          merge = settle(roots());
          await waitForWait('"User"');
        } else mergeContinue.open();
        release.open();
        await hold;
        const results = await Promise.all([finance, merge!]);
        expect(results.every((r) => r.ok)).toBe(true);
        expect(await db.usdcAllocation.count({ where: { raidId: raid.id } })).toBe(2);
        expect(await db.usdcTransfer.count({ where: { kind: 'REWARD' } })).toBe(2);
        expect(
          (await db.balanceEntry.findUniqueOrThrow({ where: { key: 'raid-settle:' + raid.id } }))
            .reservedDelta,
        ).toBe(-10000000n);
        expect(
          (
            await db.usdcAllocation.aggregate({
              where: { raidId: raid.id },
              _sum: { amount: true },
            })
          )._sum.amount,
        ).toBe(10000000n);
      } finally {
        mergeContinue.open();
        release.open();
        await Promise.allSettled([finance, merge!, hold]);
        await db.$executeRawUnsafe('DROP TRIGGER zz_protocol_finance_pause ON "UsdcAllocation"');
      }
    },
    20000,
  );

  it('finance holds SHARE for the creator status predicate while preserving the exact settlement', async () => {
    const { creator, raid } = await financeFixture(),
      ready = gate(),
      release = gate();
    intercept(async (_tx, model, method) => {
      if (model === 'usdcAllocation' && method === 'createMany') {
        ready.open();
        await release.promise;
      }
    });
    const finance = allocateUsdcRaid(raid.id);
    await ready.promise;
    let done = false;
    const suspend = locker.user
      .update({ where: { id: creator.id }, data: { suspended: true } })
      .then(() => {
        done = true;
      });
    try {
      await Promise.race([waitForWait('UPDATE "public"."User"'), suspend]);
      expect(done).toBe(false);
    } finally {
      release.open();
      await Promise.all([finance, suspend]);
    }
    expect(await db.usdcAllocation.count()).toBe(2);
    expect((await db.usdcAllocation.aggregate({ _sum: { amount: true } }))._sum.amount).toBe(
      10000000n,
    );
  });
  it('finance rechecks creator restriction after acquiring its final root, before any settlement insert', async () => {
    const { creator, raid } = await financeFixture();
    let changed = false;
    intercept(async (_tx, model, method, args) => {
      if (
        !changed &&
        model === '$' &&
        method === '$queryRawUnsafe' &&
        String(args[0]).includes('FROM "User"') &&
        String(args[0]).includes('FOR ') &&
        args[1] === creator.id
      ) {
        changed = true;
        await locker.user.update({ where: { id: creator.id }, data: { suspended: true } });
      }
    });
    await allocateUsdcRaid(raid.id);
    expect(changed).toBe(true);
    expect(await db.usdcAllocation.count()).toBe(0);
    expect(
      await db.usdcTransfer.count({ where: { kind: { in: ['REWARD', 'REWARD_CREDIT'] } } }),
    ).toBe(0);
    expect(
      await db.balanceEntry.findUnique({ where: { key: 'raid-settle:' + raid.id } }),
    ).toBeNull();
  });
  it('denies a primary sign-in whose claimed challenge expires while waiting for its final root', async () => {
    const kp = Keypair.generate(),
      address = kp.publicKey.toBase58();
    const user = await db.user.create({ data: { handle: 'expiry' } });
    await db.walletIdentity.create({ data: { userId: user.id, address } });
    const challenge = await createWalletChallenge(address),
      expiry = new Date(Date.now() + 600);
    await db.walletChallenge.update({
      where: { digest: challenge.digest },
      data: { expiresAt: expiry },
    });
    const ready = gate(),
      release = gate();
    const held = locker.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${user.id} FOR UPDATE`;
      ready.open();
      await release.promise;
    });
    await ready.promise;
    const pending = verifyWalletChallenge(
      challenge.digest,
      bs58.encode(nacl.sign.detached(new TextEncoder().encode(challenge.message), kp.secretKey)),
      address,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await waitForWait('User');
      expect(Date.now()).toBeLessThan(+expiry);
      await new Promise((resolve) => setTimeout(resolve, +expiry - Date.now() + 30));
      release.open();
      await held;
      expect(await pending).toMatchObject({ status: 401 });
      expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
      expect(
        (await db.walletChallenge.findUniqueOrThrow({ where: { digest: challenge.digest } }))
          .consumedAt,
      ).toBeNull();
    } finally {
      release.open();
      await held;
      await pending;
    }
  });
  it('A2 obviously nonempty account is rejected before any strong root acquisition', async () => {
    const keep = await db.user.create({ data: { handle: 'keep' } }),
      drop = await db.user.create({ data: { handle: 'drop' } });
    await db.usdcTransfer.create({
      data: {
        userId: drop.id,
        kind: 'DEPOSIT',
        amount: 1n,
        walletAddress: 'fixture',
        recipient: 'fixture',
        network: 'mainnet',
        mint: 'fixture',
      },
    });
    const root = gate(),
      release = gate();
    const held = locker.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${drop.id} FOR UPDATE`;
      root.open();
      await release.promise;
    });
    await root.promise;
    const merge = settle(db.$transaction((tx) => absorbAccount(tx, keep.id, drop.id)));
    try {
      const fast = await Promise.race([
        merge,
        new Promise<null>((r) => setTimeout(() => r(null), 500)),
      ]);
      expect(fast).toMatchObject({ ok: false, error: { status: 409 } });
    } finally {
      release.open();
      await Promise.allSettled([held, merge]);
    }
  }, 10000);

  it('A3 real User-delete 23503 becomes terminal account-not-empty and rolls back the merge', async () => {
    const keep = await db.user.create({ data: { handle: 'keep' } }),
      drop = await db.user.create({ data: { handle: 'drop' } });
    // A legacy/future activity reference not in the optimistic counts; PostgreSQL remains the
    // authority at DELETE. This fixture creates a real 23503, not a mocked driver exception.
    await db.$executeRawUnsafe(
      'CREATE TABLE IF NOT EXISTS protocol_external_activity ("userId" text REFERENCES "User"(id) ON DELETE RESTRICT)',
    );
    await db.$executeRaw`INSERT INTO protocol_external_activity ("userId") VALUES (${drop.id})`;
    await expect(
      db.$transaction((tx) => absorbAccount(tx, keep.id, drop.id)),
    ).rejects.toMatchObject({
      status: 409,
      message: 'Only an activity-free account can be merged.',
    });
    expect(await db.user.count({ where: { id: { in: [keep.id, drop.id] } } })).toBe(2);
    expect(await db.moderationEvent.count({ where: { action: 'account:merge' } })).toBe(0);
    await db.$executeRawUnsafe('DROP TABLE protocol_external_activity');
  });
});
