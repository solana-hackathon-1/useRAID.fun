import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { db } from '../src/lib/db';
import { config } from '../src/lib/config';
import { hash } from '../src/lib/auth-primitives';
import { createWalletChallenge, linkAdditionalWallet } from '../src/lib/wallet-auth';
import { absorbAccount } from '../src/lib/account-merge';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

// DEC-2026-10-09-01 as clarified by the owner on 2026-10-10: the CURRENT session must carry X
// authority (via === 'x'). The authority is observed under the wallet-subject and account locks,
// so a change that commits while the command waits for those locks is seen, not ignored.
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
async function account(via = 'x', expiresAt = new Date(Date.now() + 60000)) {
  const n = `authority-${++counter}`;
  const user = await db.user.create({ data: { handle: n, xId: n } });
  await db.xAccount.create({ data: { userId: user.id, xUserId: n, username: n, displayName: n } });
  const primary = pair();
  await db.walletIdentity.create({ data: { userId: user.id, address: primary.address } });
  const sessionHash = hash(n);
  await db.session.create({ data: { userId: user.id, tokenHash: sessionHash, via, expiresAt } });
  return { id: user.id, sessionHash };
}
const challenge = (a: { id: string }, w: Wallet) =>
  createWalletChallenge(w.address, a.id, 'link-additional');
const invoke = (
  a: { id: string; sessionHash: string },
  w: Wallet,
  c: { digest: string; message: string },
  requestId = 'authority-command',
) => linkAdditionalWallet(a.id, c.digest, w.sign(c.message), w.address, a.sessionHash, requestId);
const unconsumed = async (digest: string) =>
  expect((await db.walletChallenge.findUniqueOrThrow({ where: { digest } })).consumedAt).toBeNull();
const noEffects = async (accountId: string) => {
  expect(await db.walletLink.count({ where: { accountId } })).toBe(0);
  expect(await db.participant.count({ where: { accountId } })).toBe(0);
};

async function holdSubject(address: string) {
  let ready!: (pid: number) => void;
  let release!: () => void;
  const started = new Promise<number>((r) => (ready = r));
  const gate = new Promise<void>((r) => (release = r));
  const held = locker.$transaction(async (tx) => {
    const [row] = await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
    await tx.$queryRawUnsafe(
      'SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended($1, 0))) AS x',
      `wallet-subject:${address}`,
    );
    ready(row.pid);
    await gate;
  });
  return { pid: await started, release, held };
}
async function waitForBlocked(pid: number) {
  const stop = Date.now() + 5000;
  while (Date.now() < stop) {
    const rows = await observer.$queryRawUnsafe<{ pid: number; query: string }[]>(
      'SELECT pid, query FROM pg_stat_activity WHERE $1::integer = ANY(pg_blocking_pids(pid))',
      pid,
    );
    if (rows.length) {
      console.info(
        JSON.stringify({ authorityRace: { blocker: pid, waiters: rows.map((r) => r.pid) } }),
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('No real PostgreSQL lock wait observed');
}

async function holdParticipantSlot(accountId: string) {
  // An uncommitted Participant row makes the command's later mapping insert wait, which pins the
  // command AFTER its authority decision so a later revoke or disconnect can be observed waiting.
  let ready!: (pid: number) => void;
  let release!: () => void;
  const started = new Promise<number>((r) => (ready = r));
  const gate = new Promise<void>((r) => (release = r));
  const held = locker
    .$transaction(async (tx) => {
      const [row] = await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
      await tx.$executeRawUnsafe(
        `INSERT INTO "Participant" ("accountId", "provisionActorAccountId", "provisionRequestId") VALUES ($1, $1, 'authority-hold')`,
        accountId,
      );
      ready(row.pid);
      await gate;
      throw new Error('rollback hold');
    })
    .catch(() => undefined);
  return { pid: await started, release, held };
}
async function blockedBy(pid: number, count = 1) {
  const stop = Date.now() + 5000;
  while (Date.now() < stop) {
    const rows = await observer.$queryRawUnsafe<{ pid: number; query: string }[]>(
      'SELECT pid, query FROM pg_stat_activity WHERE $1::integer = ANY(pg_blocking_pids(pid))',
      pid,
    );
    if (rows.length >= count) return rows;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('Expected PostgreSQL lock wait was not observed');
}

integration('B2a authority: current X session, observed under locks', () => {
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

  it.each(['wallet', 'admin', '', 'X'])(
    'denies a live own session whose authority is %j even though the account has an X row',
    async (via) => {
      const a = await account(via);
      const w = pair();
      const c = await challenge(a, w);
      await expect(invoke(a, w, c)).rejects.toMatchObject({ status: 403 });
      await unconsumed(c.digest);
      await noEffects(a.id);
    },
  );

  it.each([
    ['revoked', 401],
    ['expired', 401],
    ['X disconnected', 403],
  ] as const)(
    'denies an authority change (%s) committed during a real lock wait',
    async (change, status) => {
      const a = await account();
      const w = pair();
      const c = await challenge(a, w);
      const bar = await holdSubject(w.address);
      let pending: ReturnType<typeof invoke> | undefined;
      try {
        pending = invoke(a, w, c);
        await waitForBlocked(bar.pid);
        if (change === 'revoked')
          await observer.session.delete({ where: { tokenHash: a.sessionHash } });
        if (change === 'expired')
          await observer.session.update({
            where: { tokenHash: a.sessionHash },
            data: { expiresAt: new Date(Date.now() - 1000) },
          });
        if (change === 'X disconnected')
          await observer.xAccount.delete({ where: { userId: a.id } });
        bar.release();
        await bar.held;
        await expect(pending).rejects.toMatchObject({ status });
        await unconsumed(c.digest);
        await noEffects(a.id);
      } finally {
        bar.release();
        await bar.held;
        await pending?.catch(() => undefined);
      }
    },
  );

  it('denies a session that expires naturally while the command waits for the lock', async () => {
    const a = await account('x', new Date(Date.now() + 1500));
    const w = pair();
    const c = await challenge(a, w);
    const bar = await holdSubject(w.address);
    let pending: ReturnType<typeof invoke> | undefined;
    try {
      pending = invoke(a, w, c);
      await waitForBlocked(bar.pid);
      await new Promise((r) => setTimeout(r, 1800));
      bar.release();
      await bar.held;
      await expect(pending).rejects.toMatchObject({ status: 401 });
      await unconsumed(c.digest);
      await noEffects(a.id);
    } finally {
      bar.release();
      await bar.held;
      await pending?.catch(() => undefined);
    }
  });

  it('either links or leaves no trace when revocation races the command, with no deadlock', async () => {
    const outcomes: string[] = [];
    for (let i = 0; i < 12; i++) {
      const a = await account();
      const w = pair();
      const c = await challenge(a, w);
      const [link, revoke, disconnect] = await Promise.allSettled([
        invoke(a, w, c, `race-${i}`),
        new Promise((r) => setTimeout(r, i * 4)).then(() =>
          observer.session.deleteMany({ where: { tokenHash: a.sessionHash } }),
        ),
        i % 2 ? observer.xAccount.deleteMany({ where: { userId: a.id } }) : Promise.resolve(),
      ]);
      expect(revoke.status).toBe('fulfilled');
      expect(disconnect.status).toBe('fulfilled');
      const linked = await db.walletLink.count({ where: { accountId: a.id } });
      const consumed = (await db.walletChallenge.findUniqueOrThrow({ where: { digest: c.digest } }))
        .consumedAt;
      if (link.status === 'fulfilled') {
        outcomes.push('linked');
        expect(linked).toBe(1);
        expect(consumed).not.toBeNull();
      } else {
        outcomes.push(`denied:${(link.reason as { status?: number }).status}`);
        expect([401, 403]).toContain((link.reason as { status?: number }).status);
        expect(linked).toBe(0);
        expect(consumed).toBeNull();
      }
    }
    console.info(JSON.stringify({ authorityRaceOutcomes: outcomes }));
  });

  it('makes a revoke or X disconnect that arrives after the decision wait for the link to commit', async () => {
    const a = await account();
    const w = pair();
    const c = await challenge(a, w);
    const hold = await holdParticipantSlot(a.id);
    let link: ReturnType<typeof invoke> | undefined;
    let revoke: Promise<unknown> | undefined;
    let disconnect: Promise<unknown> | undefined;
    try {
      link = invoke(a, w, c);
      const [waiter] = await blockedBy(hold.pid);
      // Prisma queries are lazy; Promise.resolve starts them now.
      revoke = Promise.resolve(
        observer.session.deleteMany({ where: { tokenHash: a.sessionHash } }),
      );
      disconnect = Promise.resolve(observer.xAccount.deleteMany({ where: { userId: a.id } }));
      // Both writers are blocked by the command itself, not by the holder.
      const writers = await blockedBy(waiter.pid, 2);
      console.info(
        JSON.stringify({
          authorityLateWriters: { command: waiter.pid, writers: writers.map((r) => r.pid) },
        }),
      );
      hold.release();
      await hold.held;
      await expect(link).resolves.toMatchObject({ status: 'ACTIVE' });
      await Promise.all([revoke, disconnect]);
      expect(await db.walletLink.count({ where: { accountId: a.id } })).toBe(1);
      expect(await db.session.count({ where: { tokenHash: a.sessionHash } })).toBe(0);
    } finally {
      hold.release();
      await hold.held;
      await Promise.allSettled([link, revoke, disconnect]);
    }
  });

  it('makes an X disconnect alone, arriving after the decision, wait for the link to commit', async () => {
    const a = await account();
    const w = pair();
    const c = await challenge(a, w);
    const hold = await holdParticipantSlot(a.id);
    let link: ReturnType<typeof invoke> | undefined;
    let disconnect: Promise<unknown> | undefined;
    try {
      link = invoke(a, w, c);
      const [waiter] = await blockedBy(hold.pid);
      disconnect = Promise.resolve(observer.xAccount.deleteMany({ where: { userId: a.id } }));
      // Only the X writer exists: its blocker must be the command's own XAccount row lock.
      const [writer] = await blockedBy(waiter.pid);
      expect(writer.pid).not.toBe(waiter.pid);
      hold.release();
      await hold.held;
      await expect(link).resolves.toMatchObject({ status: 'ACTIVE' });
      await disconnect;
      expect(await db.walletLink.count({ where: { accountId: a.id } })).toBe(1);
      expect(await db.xAccount.count({ where: { userId: a.id } })).toBe(0);
    } finally {
      hold.release();
      await hold.held;
      await Promise.allSettled([link, disconnect]);
    }
  });

  it('does not deadlock with the legacy account merge while the command holds its locks (N1)', async () => {
    const a = await account();
    const keep = await db.user.create({ data: { handle: 'merge-keep' } });
    const w = pair();
    const c = await challenge(a, w);
    // Pin the command after it holds the account lock but before it reads the X row.
    let ready!: (pid: number) => void;
    let release!: () => void;
    const started = new Promise<number>((r) => (ready = r));
    const gate = new Promise<void>((r) => (release = r));
    const held = locker.$transaction(async (tx) => {
      const [row] = await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
      await tx.$queryRawUnsafe(
        'SELECT 1 FROM "Session" WHERE "tokenHash" = $1 FOR UPDATE',
        a.sessionHash,
      );
      ready(row.pid);
      await gate;
    });
    const holderPid = await started;
    let link: ReturnType<typeof invoke> | undefined;
    let merge: Promise<unknown> | undefined;
    try {
      link = invoke(a, w, c);
      const [waiter] = await blockedBy(holderPid);
      merge = Promise.resolve(
        db.$transaction((tx) => absorbAccount(tx, keep.id, a.id), { timeout: 20000 }),
      ).then(
        () => ({ ok: true as const }),
        (error: Error) => ({ ok: false as const, message: String(error?.message ?? error) }),
      );
      // The merge must queue behind the command's account lock, never hold an X delete first.
      await blockedBy(waiter.pid);
      release();
      await held;
      await expect(link).resolves.toMatchObject({ status: 'ACTIVE' });
      const merged = (await merge) as { ok: boolean; message?: string };
      expect(merged.ok).toBe(false);
      expect(merged.message).toContain('Only an activity-free account can be merged');
      expect(merged.message).not.toMatch(/deadlock/i);
    } finally {
      release();
      await held.catch(() => undefined);
      await Promise.allSettled([link, merge]);
    }
  }, 30000);
});
