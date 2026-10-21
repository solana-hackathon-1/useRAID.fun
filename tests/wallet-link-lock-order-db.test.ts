import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { db } from '../src/lib/db';
import { config } from '../src/lib/config';
import { hash } from '../src/lib/auth-primitives';
import {
  createWalletChallenge,
  linkAdditionalWallet,
  verifyWalletChallenge,
} from '../src/lib/wallet-auth';
import { absorbAccount } from '../src/lib/account-merge';
import { completeConnection } from '../src/lib/x-oauth';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

// T006 B2a re-review rejection (CR-B2-01, CR-B2-02). Both defects only appear while a command is
// blocked inside real PostgreSQL lock waits, so these tests hold the real locks from a second
// connection, observe the waiter through pg_blocking_pids and only then change the world.
//   CR-B2-01: authority must be judged by a database clock read AFTER the Session/XAccount row
//             locks are granted, never by a time captured before a blocking wait.
//   CR-B2-02: identity writers share one lock order (X advisory lock, then User rows, then
//             Session/XAccount rows) so a merge and an X reconnect cannot deadlock.
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const observer = new PrismaClient();
const locker = new PrismaClient({ transactionOptions: { timeout: 20000 } });
const pair = () => {
  const kp = Keypair.generate();
  return {
    address: kp.publicKey.toBase58(),
    sign: (m: string) => bs58.encode(nacl.sign.detached(new TextEncoder().encode(m), kp.secretKey)),
  };
};
type Wallet = ReturnType<typeof pair>;
let counter = 0;
async function account(expiresAt = new Date(Date.now() + 60000)) {
  const n = `lock-order-${++counter}`;
  const user = await db.user.create({ data: { handle: n, xId: n } });
  await db.xAccount.create({ data: { userId: user.id, xUserId: n, username: n, displayName: n } });
  await db.walletIdentity.create({ data: { userId: user.id, address: pair().address } });
  const sessionHash = hash(n);
  await db.session.create({
    data: { userId: user.id, tokenHash: sessionHash, via: 'x', expiresAt },
  });
  return { id: user.id, xId: n, sessionHash };
}
const invoke = (
  a: { id: string; sessionHash: string },
  w: Wallet,
  c: { digest: string; message: string },
) =>
  linkAdditionalWallet(a.id, c.digest, w.sign(c.message), w.address, a.sessionHash, 'lock-order');
const outcome = (promise: Promise<unknown>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: { status?: number; message?: string; code?: string; meta?: unknown }) => ({
      ok: false as const,
      status: error.status,
      message: error.message,
      code: error.code,
      meta: error.meta,
    }),
  );

// Holds `sql` (bound to `bind`) inside an open transaction on its own connection until released.
async function hold(sql: string, bind: string, then?: string) {
  let ready!: (pid: number) => void;
  let release!: () => void;
  const started = new Promise<number>((r) => (ready = r));
  const gate = new Promise<void>((r) => (release = r));
  const held = locker.$transaction(async (tx) => {
    const [row] = await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
    await tx.$queryRawUnsafe(sql, bind);
    if (then) await tx.$queryRawUnsafe(then, bind);
    ready(row.pid);
    await gate;
  });
  return { pid: await started, release, held };
}
// Waits until some backend is observed blocked behind `pid` running a statement containing `needle`.
async function blocked(pid: number, needle: string) {
  const stop = Date.now() + 5000;
  while (Date.now() < stop) {
    const rows = await observer.$queryRawUnsafe<{ pid: number; query: string }[]>(
      'SELECT pid, query FROM pg_stat_activity WHERE $1::integer = ANY(pg_blocking_pids(pid))',
      pid,
    );
    const waiter = rows.find((row) => row.query.includes(needle));
    if (waiter) {
      console.info(JSON.stringify({ lockOrderWait: { blocker: pid, waiter: waiter.pid, needle } }));
      return waiter;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`No backend observed waiting on: ${needle}`);
}

// A wallet-only account (xId null) with a primary wallet, a live wallet session and a claimed
// OAuth attempt: the account that is about to make its FIRST X connection.
async function walletOnly() {
  const n = `wallet-only-${++counter}`;
  const wallet = pair();
  const user = await db.user.create({ data: { handle: n } });
  await db.walletIdentity.create({ data: { userId: user.id, address: wallet.address } });
  const sessionHash = hash(n);
  await db.session.create({
    data: {
      userId: user.id,
      tokenHash: sessionHash,
      via: 'wallet',
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  const attempt = await db.oAuthAttempt.create({
    data: {
      stateHash: hash(`state-${n}`),
      verifier: 'synthetic',
      userId: user.id,
      sessionHash,
      consumedAt: new Date(),
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  return {
    id: user.id,
    wallet,
    sessionHash,
    attempt,
    profile: { id: `first-x-${n}`, username: n, name: n },
  };
}
// An X-connected account with no primary wallet: the natural keeper of a wallet fold or merge.
async function xKeeper() {
  const n = `x-keeper-${++counter}`;
  const user = await db.user.create({ data: { handle: n, xId: n } });
  await db.xAccount.create({ data: { userId: user.id, xUserId: n, username: n, displayName: n } });
  const sessionHash = hash(n);
  await db.session.create({
    data: {
      userId: user.id,
      tokenHash: sessionHash,
      via: 'x',
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  return { id: user.id, xId: n, sessionHash };
}

integration('T006 B2a lock waits keep authority and lock order sound', () => {
  beforeEach(async () => {
    assertTestDatabase();
    config.demo = false;
    config.appUrl = 'http://localhost:3000';
    process.env.WALLET_LINKS_ENABLED = 'true';
    await truncateAll(db);
  });
  afterAll(async () => {
    delete process.env.WALLET_LINKS_ENABLED;
    await Promise.all([db.$disconnect(), observer.$disconnect(), locker.$disconnect()]);
  });

  it.each(['Session', 'XAccount'] as const)(
    'denies a link whose X session expires while it waits for the %s row lock',
    async (table) => {
      const expiry = new Date(Date.now() + 2500);
      const a = await account(expiry);
      const w = pair();
      const c = await createWalletChallenge(w.address, a.id, 'link-additional');
      const holder =
        table === 'Session'
          ? await hold('SELECT 1 FROM "Session" WHERE "tokenHash" = $1 FOR UPDATE', a.sessionHash)
          : await hold('SELECT 1 FROM "XAccount" WHERE "userId" = $1 FOR UPDATE', a.id);
      let pending: ReturnType<typeof outcome> | undefined;
      try {
        pending = outcome(invoke(a, w, c));
        await blocked(holder.pid, `FROM "${table}"`);
        // The session must still be live while the command waits, or the test proves nothing.
        expect(Date.now()).toBeLessThan(+expiry);
        await new Promise((r) => setTimeout(r, +expiry - Date.now() + 250));
        holder.release();
        await holder.held;
        expect(await pending).toMatchObject({ ok: false, status: 401 });
        expect(
          (await db.walletChallenge.findUniqueOrThrow({ where: { digest: c.digest } })).consumedAt,
        ).toBeNull();
        expect(await db.walletLink.count({ where: { accountId: a.id } })).toBe(0);
        expect(await db.participant.count({ where: { accountId: a.id } })).toBe(0);
      } finally {
        holder.release();
        await holder.held;
        await pending;
      }
    },
    15000,
  );

  it('does not deadlock a merge against an X reconnect of the same account', async () => {
    const a = await account();
    const keep = await db.user.create({ data: { handle: 'lock-order-keep' } });
    const attempt = await db.oAuthAttempt.create({
      data: {
        stateHash: hash('lock-order-state'),
        verifier: 'synthetic',
        userId: a.id,
        sessionHash: a.sessionHash,
        consumedAt: new Date(),
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    // The callback takes the X advisory lock, then blocks deleting its claimed attempt.
    const holder = await hold(
      'SELECT 1 FROM "OAuthAttempt" WHERE "stateHash" = $1 FOR UPDATE',
      attempt.stateHash,
    );
    let connection: ReturnType<typeof outcome> | undefined;
    let merge: ReturnType<typeof outcome> | undefined;
    try {
      connection = outcome(
        completeConnection(attempt, { id: a.xId, username: a.xId, name: a.xId }),
      );
      const callback = await blocked(holder.pid, 'OAuthAttempt');
      merge = outcome(
        db.$transaction((tx) => absorbAccount(tx, keep.id, a.id), { timeout: 20000 }),
      );
      // The merge must queue behind the callback's X advisory lock before it touches any User row.
      await blocked(callback.pid, 'pg_advisory_xact_lock');
      holder.release();
      await holder.held;
      const results = await Promise.all([connection, merge]);
      expect(JSON.stringify(results)).not.toMatch(/deadlock|40P01/i);
      expect(results).toMatchObject([{ ok: true }, { ok: true }]);
      // Serialized outcome: the reconnect committed first, then the merge folded the account.
      expect(await db.user.findUnique({ where: { id: a.id } })).toBeNull();
      expect(await db.user.findUniqueOrThrow({ where: { id: keep.id } })).toMatchObject({
        xId: a.xId,
      });
      expect(await db.xAccount.count({ where: { userId: keep.id } })).toBe(1);
    } finally {
      holder.release();
      await holder.held;
      await Promise.allSettled([connection, merge]);
    }
  }, 15000);

  it('refuses a merge when the dropped account connected X while the merge waited for its row', async () => {
    const keep = await db.user.create({ data: { handle: 'lock-order-keep-2' } });
    const drop = await db.user.create({ data: { handle: 'lock-order-drop-2' } });
    // A concurrent connect holds the drop row and commits an X identity before releasing it.
    const holder = await hold(
      'SELECT 1 FROM "User" WHERE "id" = $1 FOR UPDATE',
      drop.id,
      `UPDATE "User" SET "xId" = 'lock-order-late-x' WHERE "id" = $1`,
    );
    let merge: ReturnType<typeof outcome> | undefined;
    try {
      merge = outcome(
        db.$transaction((tx) => absorbAccount(tx, keep.id, drop.id), { timeout: 20000 }),
      );
      await blocked(holder.pid, 'FOR UPDATE');
      holder.release();
      await holder.held;
      expect(await merge).toMatchObject({ ok: false });
      // Fail closed: nothing was folded and the late X identity is intact.
      expect(await db.user.findUniqueOrThrow({ where: { id: drop.id } })).toMatchObject({
        xId: 'lock-order-late-x',
      });
      expect(await db.moderationEvent.count({ where: { action: 'account:merge' } })).toBe(0);
    } finally {
      holder.release();
      await holder.held;
      await merge;
    }
  }, 15000);
  // CR-B2-05: the first X connection of an account with xId = null takes only the advisory lock of
  // the NEW X id, so the dropped account's merge shares no X lock with it. The callback deletes
  // the claimed OAuthAttempt row and then updates the User; the merge locked the User and then
  // deleted the same attempt row: attempt -> User versus User -> attempt (SQLSTATE 40P01).
  describe.each([
    ['merge', 'absorbAccount'],
    ['wallet fold', 'verifyWalletChallenge'],
  ] as const)('first X connection versus %s', (_label, entry) => {
    it('serializes without a deadlock and fails the merge closed after the connection wins', async () => {
      const drop = await walletOnly();
      const keep = await xKeeper();
      const challenge =
        entry === 'verifyWalletChallenge'
          ? await createWalletChallenge(drop.wallet.address, keep.id)
          : null;
      const holder = await hold(
        'SELECT 1 FROM "OAuthAttempt" WHERE "stateHash" = $1 FOR UPDATE',
        drop.attempt.stateHash,
      );
      // Exercise the explicitly enabled legacy fold in this synthetic fixture;
      // separate account-fold-gate regressions retain the default-off production contract.
      const previousFolds = process.env.ACCOUNT_FOLDS_ENABLED;
      process.env.ACCOUNT_FOLDS_ENABLED = 'true';
      let connection: ReturnType<typeof outcome> | undefined;
      let other: ReturnType<typeof outcome> | undefined;
      try {
        connection = outcome(completeConnection(drop.attempt, drop.profile));
        const callback = await blocked(holder.pid, 'OAuthAttempt');
        other = outcome(
          challenge
            ? verifyWalletChallenge(
                challenge.digest,
                drop.wallet.sign(challenge.message),
                drop.wallet.address,
                keep.id,
                keep.sessionHash,
              )
            : db.$transaction((tx) => absorbAccount(tx, keep.id, drop.id), { timeout: 20000 }),
        );
        await blocked(callback.pid, 'pg_advisory_xact_lock');
        holder.release();
        await holder.held;
        const results = await Promise.all([connection, other]);
        expect(JSON.stringify(results)).not.toMatch(/deadlock|40P01/i);
        // The connection queued first and wins; the merge then sees the account gained an X id.
        expect(results[0]).toMatchObject({ ok: true });
        expect(results[1]).toMatchObject({
          ok: false,
          message: challenge ? 'Wallet belongs to another account.' : 'PLAN_CHANGED',
        });
        expect(await db.user.findUniqueOrThrow({ where: { id: drop.id } })).toMatchObject({
          xId: drop.profile.id,
        });
        expect(await db.xAccount.count({ where: { userId: drop.id } })).toBe(1);
        expect(await db.walletIdentity.count({ where: { userId: drop.id } })).toBe(1);
        expect(await db.user.findUniqueOrThrow({ where: { id: keep.id } })).toMatchObject({
          xId: keep.xId,
        });
        expect(await db.moderationEvent.count({ where: { action: 'account:merge' } })).toBe(0);
        if (challenge)
          expect(
            (await db.walletChallenge.findUniqueOrThrow({ where: { digest: challenge.digest } }))
              .consumedAt,
          ).toBeNull();
      } finally {
        holder.release();
        await holder.held;
        await Promise.allSettled([connection, other]);
        if (previousFolds === undefined) delete process.env.ACCOUNT_FOLDS_ENABLED;
        else process.env.ACCOUNT_FOLDS_ENABLED = previousFolds;
      }
    }, 15000);
  });

  it('lets unrelated merges and a first X connection proceed without waiting on each other', async () => {
    const connecting = await walletOnly();
    const dropA = await walletOnly();
    const keepA = await xKeeper();
    const dropB = await walletOnly();
    const keepB = await xKeeper();
    const holder = await hold(
      'SELECT 1 FROM "OAuthAttempt" WHERE "stateHash" = $1 FOR UPDATE',
      connecting.attempt.stateHash,
    );
    let connection: ReturnType<typeof outcome> | undefined;
    try {
      connection = outcome(completeConnection(connecting.attempt, connecting.profile));
      await blocked(holder.pid, 'OAuthAttempt');
      // Two unrelated merges finish while the connection is still parked on its own attempt.
      const merges = await Promise.all([
        outcome(db.$transaction((tx) => absorbAccount(tx, keepA.id, dropA.id), { timeout: 20000 })),
        outcome(db.$transaction((tx) => absorbAccount(tx, keepB.id, dropB.id), { timeout: 20000 })),
      ]);
      expect(merges).toMatchObject([{ ok: true }, { ok: true }]);
      expect(await db.user.findUnique({ where: { id: dropA.id } })).toBeNull();
      expect(await db.user.findUnique({ where: { id: dropB.id } })).toBeNull();
      holder.release();
      await holder.held;
      expect(await connection).toMatchObject({ ok: true });
      expect(await db.user.findUniqueOrThrow({ where: { id: connecting.id } })).toMatchObject({
        xId: connecting.profile.id,
      });
    } finally {
      holder.release();
      await holder.held;
      await connection;
    }
  }, 15000);
});
