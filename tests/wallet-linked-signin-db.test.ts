import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { db } from '../src/lib/db';
import { config } from '../src/lib/config';
import { hash } from '../src/lib/auth-primitives';
import { createWalletChallenge, verifyWalletChallenge, rotateWallet } from '../src/lib/wallet-auth';
import { linkVerifiedWallet, lookupWalletLink } from '../src/identity-link';
import { createPrismaIdentityTransaction } from '../src/lib/identity-storage-adapter';
import { fixtureLinkInput } from './helpers/wallet-link-fixtures';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const pair = () => {
  const key = Keypair.generate();
  return {
    address: key.publicKey.toBase58(),
    sign: (message: string) =>
      bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), key.secretKey)),
  };
};
const snapshot = async () => {
  const result: Record<string, unknown> = {};
  for (const table of [
    'User',
    'Participant',
    'WalletIdentity',
    'WalletLink',
    'BalanceEntry',
    'UsdcTransfer',
    'UsdcAllocation',
    'RaidEnrollment',
    'RewardEnrollment',
  ]) {
    result[table] = await db.$queryRawUnsafe(
      `SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`,
    );
  }
  return result;
};
integration('linked-wallet sign-in host (T006 PR-B1)', () => {
  let primary: ReturnType<typeof pair>;
  let second: ReturnType<typeof pair>;
  let ownerId: string;
  beforeAll(() => {
    assertTestDatabase();
    config.demo = false;
    config.appUrl = 'http://localhost:3000';
  });
  beforeEach(async () => {
    await truncateAll(db);
    primary = pair();
    second = pair();
    const owner = await db.user.create({
      data: { handle: 'synthetic-linked-owner', xId: 'synthetic-owner-x' },
    });
    ownerId = owner.id;
    await db.xAccount.create({
      data: {
        userId: ownerId,
        xUserId: 'synthetic-owner-x',
        username: 'synthetic-owner',
        displayName: 'Synthetic owner',
      },
    });
    await db.walletIdentity.create({ data: { userId: ownerId, address: primary.address } });
    await db.balanceEntry.create({
      data: {
        userId: ownerId,
        kind: 'TEST_FUNDS',
        availableDelta: 7n,
        reservedDelta: 0n,
        network: 'sandbox',
        key: 'synthetic-signin-history',
      },
    });
    await db.$transaction((tx) =>
      linkVerifiedWallet(
        createPrismaIdentityTransaction(tx),
        fixtureLinkInput(ownerId, second.address),
      ),
    );
  });
  afterAll(async () => {
    await truncateAll(db);
    await db.$disconnect();
  });
  const verify = async (wallet = second, currentUserId?: string, sessionHash?: string) => {
    const challenge = await createWalletChallenge(wallet.address, currentUserId);
    return verifyWalletChallenge(
      challenge.digest,
      wallet.sign(challenge.message),
      wallet.address,
      currentUserId,
      sessionHash,
    );
  };
  it('fresh linked signature yields same account; participant, primary and history stay byte-identical', async () => {
    const before = await snapshot();
    const token = await verify();
    expect(await db.session.findUniqueOrThrow({ where: { tokenHash: hash(token) } })).toMatchObject(
      { userId: ownerId, via: 'wallet' },
    );
    expect(await snapshot()).toEqual(before);
    expect(await db.walletChallenge.count({ where: { consumedAt: { not: null } } })).toBe(1);
  });
  it('same-account reauthentication with a linked wallet preserves a valid X session', async () => {
    await db.session.create({
      data: {
        tokenHash: hash('synthetic-x-session'),
        userId: ownerId,
        via: 'x',
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    const before = await snapshot();
    const token = await verify(second, ownerId, hash('synthetic-x-session'));
    expect(await db.session.findUniqueOrThrow({ where: { tokenHash: hash(token) } })).toMatchObject(
      { userId: ownerId, via: 'x' },
    );
    expect(await snapshot()).toEqual(before);
    expect(await db.session.count()).toBe(1);
  });
  it.each(['REVOKED', 'WRONG_NETWORK', 'SUSPENDED'])(
    'rejects %s linked credential without challenge/session residue',
    async (state) => {
      if (state === 'REVOKED')
        await db.walletLink.updateMany({
          where: { accountId: ownerId },
          data: { status: 'REVOKED', revokedAt: new Date() },
        });
      if (state === 'SUSPENDED')
        await db.user.update({ where: { id: ownerId }, data: { suspended: true } });
      if (state === 'WRONG_NETWORK') {
        // Immutable network cannot be edited: create the wrong-network fixture from a fresh target.
        await truncateAll(db);
        await db.user.create({ data: { id: ownerId, handle: 'synthetic-owner' } });
        await db.walletIdentity.create({ data: { userId: ownerId, address: primary.address } });
        await db.$transaction((tx) =>
          linkVerifiedWallet(
            createPrismaIdentityTransaction(tx),
            fixtureLinkInput(ownerId, second.address, {
              subject: { networkIdentity: 'other-test-network', address: second.address },
              proof: {
                ...fixtureLinkInput(ownerId, second.address).proof,
                subject: {
                  kind: 'WALLET',
                  networkIdentity: 'other-test-network',
                  address: second.address,
                },
              },
              policy: {
                domain: 'localhost:3000',
                uri: 'http://localhost:3000',
                walletNetworks: ['other-test-network'],
                providers: [],
              },
            }),
          ),
        );
      }
      const before = await snapshot();
      const challenge = await createWalletChallenge(second.address);
      await expect(
        verifyWalletChallenge(challenge.digest, second.sign(challenge.message), second.address),
      ).rejects.toMatchObject({ status: state === 'SUSPENDED' ? 403 : 401 });
      expect(await db.session.count()).toBe(0);
      expect(
        (await db.walletChallenge.findUniqueOrThrow({ where: { digest: challenge.digest } }))
          .consumedAt,
      ).toBeNull();
      expect(await snapshot()).toEqual(before);
    },
  );
  it('cannot fold a linked credential into a foreign signed-in account', async () => {
    const foreign = await db.user.create({ data: { handle: 'synthetic-foreign' } });
    const before = await snapshot();
    const challenge = await createWalletChallenge(second.address, foreign.id);
    await expect(
      verifyWalletChallenge(
        challenge.digest,
        second.sign(challenge.message),
        second.address,
        foreign.id,
      ),
    ).rejects.toMatchObject({ status: 409, message: 'Wallet belongs to another account.' });
    expect(await snapshot()).toEqual(before);
    expect(await db.session.count()).toBe(0);
    expect(
      (await db.walletChallenge.findUniqueOrThrow({ where: { digest: challenge.digest } }))
        .consumedAt,
    ).toBeNull();
  });
  it.each(['ACTIVE', 'REVOKED'])(
    'rotation onto an %s link is a sanitized conflict and preserves the payout wallet',
    async (status) => {
      if (status === 'REVOKED')
        await db.walletLink.updateMany({
          where: { accountId: ownerId },
          data: { status: 'REVOKED', revokedAt: new Date() },
        });
      const before = await snapshot();
      const challenge = await createWalletChallenge(second.address, ownerId, 'rotate');
      await expect(
        rotateWallet(ownerId, challenge.digest, second.sign(challenge.message), second.address),
      ).rejects.toMatchObject({ status: 409, message: 'Wallet belongs to another account.' });
      expect(await snapshot()).toEqual(before);
      expect(
        (await db.walletChallenge.findUniqueOrThrow({ where: { digest: challenge.digest } }))
          .consumedAt,
      ).toBeNull();
    },
  );
  it('replay of a consumed linked sign-in challenge creates no second session', async () => {
    const challenge = await createWalletChallenge(second.address);
    await verifyWalletChallenge(challenge.digest, second.sign(challenge.message), second.address);
    await expect(
      verifyWalletChallenge(challenge.digest, second.sign(challenge.message), second.address),
    ).rejects.toMatchObject({ status: 401 });
    expect(await db.session.count()).toBe(1);
  });
  it.each(['expired', 'foreign'])(
    'a %s X session cannot widen anonymous linked-wallet sign-in',
    async (kind) => {
      const foreign = await db.user.create({ data: { handle: 'synthetic-foreign' } });
      await db.session.create({
        data: {
          tokenHash: hash('synthetic-old-x'),
          userId: kind === 'foreign' ? foreign.id : ownerId,
          via: 'x',
          expiresAt: new Date(Date.now() + (kind === 'expired' ? -60000 : 60000)),
        },
      });
      const token = await verify(second, undefined, hash('synthetic-old-x'));
      expect(
        await db.session.findUniqueOrThrow({ where: { tokenHash: hash(token) } }),
      ).toMatchObject({ userId: ownerId, via: 'wallet' });
    },
  );
  it('revocation committed before lookup completes prevents a real fresh sign-in (pg_blocking_pids)', async () => {
    const challenge = await createWalletChallenge(second.address);
    let ready!: (pid: number) => void;
    let release!: () => void;
    const started = new Promise<number>((resolve) => {
      ready = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = db.$transaction(
      async (tx) => {
        await tx.walletLink.updateMany({
          where: { accountId: ownerId },
          data: { status: 'REVOKED', revokedAt: new Date() },
        });
        ready(
          (await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid'))[0].pid,
        );
        await gate;
      },
      { timeout: 20000 },
    );
    const blocker = await started;
    const outcome = verifyWalletChallenge(
      challenge.digest,
      second.sign(challenge.message),
      second.address,
    ).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    );
    try {
      await observedBlock(blocker, /FOR SHARE/);
    } finally {
      release();
      await holder;
    }
    expect((await outcome).error).toMatchObject({ status: 401 });
    expect(await db.session.count()).toBe(0);
    expect(
      (await db.walletChallenge.findUniqueOrThrow({ where: { digest: challenge.digest } }))
        .consumedAt,
    ).toBeNull();
    expect(await db.user.count()).toBe(1);
    expect(await db.participant.count()).toBe(1);
  });
  it('credential lookup holds its link row until host commit; concurrent raw revoke waits (pg_blocking_pids)', async () => {
    let ready!: (pid: number) => void;
    let release!: () => void;
    const started = new Promise<number>((resolve) => {
      ready = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = db.$transaction(
      async (tx) => {
        expect(
          await lookupWalletLink(createPrismaIdentityTransaction(tx), second.address),
        ).toMatchObject({ accountId: ownerId, status: 'ACTIVE' });
        ready(
          (await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid'))[0].pid,
        );
        await gate;
      },
      { timeout: 20000 },
    );
    const blocker = await started;
    const revoke = db.walletLink.updateMany({
      where: { accountId: ownerId },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    const outcome = Promise.resolve(revoke);
    try {
      await observedBlock(blocker, /UPDATE/);
    } finally {
      release();
      await holder;
    }
    expect((await outcome).count).toBe(1);
    expect((await db.walletLink.findFirstOrThrow({ where: { accountId: ownerId } })).status).toBe(
      'REVOKED',
    );
  });
});

async function observedBlock(blocker: number, statement: RegExp) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const waiters = await db.$queryRawUnsafe<{ pid: number; query: string; blockers: number[] }[]>(
      'SELECT pid, query, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE $1::integer = ANY(pg_blocking_pids(pid))',
      blocker,
    );
    const waiter = waiters.find((row) => statement.test(row.query));
    if (waiter) {
      expect(waiter.pid).not.toBe(blocker);
      expect(waiter.blockers).toContain(blocker);
      console.info(
        JSON.stringify({
          linkedSigninRace: true,
          waiter: waiter.pid,
          blocker,
          blockedStatement: waiter.query.slice(0, 140),
        }),
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error('Independent PostgreSQL blocking relation was not observed');
}
