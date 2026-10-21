// Derived from the independent candidate-3 probes; original no-deadlock and state assertions retained.
// Only imports, explicit isolated fold gate, database-scoped waits and output redaction changed.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { Keypair } from '@solana/web3.js';
import { db } from '../../../../src/lib/db';
import { config } from '../../../../src/lib/config';
import { hash } from '../../../../src/lib/auth-primitives';
import { absorbAccount } from '../../../../src/lib/account-merge';
import { completeConnection, startAttempt } from '../../../../src/lib/x-oauth';
import { assertTestDatabase, truncateAll } from '../../../../tests/helpers/db-guard';
const observer = new PrismaClient();
const locker = new PrismaClient({ transactionOptions: { timeout: 20000 } });
const pair = () => ({ address: Keypair.generate().publicKey.toBase58() });
let n = 0;
async function account(expiresAt = new Date(Date.now() + 60000)) {
  const x = `new-review-${++n}`;
  const user = await db.user.create({ data: { handle: x, xId: x } });
  await db.xAccount.create({ data: { userId: user.id, xUserId: x, username: x, displayName: x } });
  const primary = pair();
  await db.walletIdentity.create({ data: { userId: user.id, address: primary.address } });
  const sessionHash = hash(x);
  await db.session.create({
    data: { userId: user.id, tokenHash: sessionHash, via: 'x', expiresAt },
  });
  return { id: user.id, xId: x, sessionHash, primary };
}
async function hold(sql: string, bind: string) {
  let ready!: (pid: number) => void, release!: () => void;
  const started = new Promise<number>((r) => (ready = r)),
    gate = new Promise<void>((r) => (release = r));
  const held = locker.$transaction(async (tx) => {
    const [row] = await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
    await tx.$queryRawUnsafe(sql, bind);
    ready(row.pid);
    await gate;
  });
  return { pid: await started, release, held };
}
async function blocked(pid: number, needle = '') {
  const until = Date.now() + 3500;
  while (Date.now() < until) {
    const rows = await observer.$queryRawUnsafe<{ pid: number; query: string }[]>(
      'SELECT pid,query FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))',
      pid,
    );
    const r = rows.find((r) => r.query.includes(needle));
    if (r) {
      console.info(JSON.stringify({ reviewWait: { blocker: pid, waiter: r } }));
      return r;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error(`No observed wait: ${needle}`);
}
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => ({ ok: true as const }),
    (e) => ({
      ok: false as const,
      status: e.status,
      message: e.message,
      code: e.code,
      meta: e.meta,
    }),
  );

async function walletOnly() {
  const a = await account();
  await db.xAccount.deleteMany({ where: { userId: a.id } });
  await db.user.update({ where: { id: a.id }, data: { xId: null } });
  await db.session.update({ where: { tokenHash: a.sessionHash }, data: { via: 'wallet' } });
  return a;
}
async function keeper() {
  const a = await account();
  await db.walletIdentity.deleteMany({ where: { userId: a.id } });
  return a;
}
async function attempt(
  a: { id: string; sessionHash: string },
  key = hash(`candidate3-attempt-${++n}`),
  expired = false,
) {
  return db.oAuthAttempt.create({
    data: {
      stateHash: key,
      userId: a.id,
      sessionHash: a.sessionHash,
      verifier: 'synthetic',
      consumedAt: new Date(),
      expiresAt: new Date(Date.now() + (expired ? -60000 : 60000)),
    },
  });
}
async function waiters(count: number) {
  const stop = Date.now() + 3500;
  let rows: { pid: number; query: string; blockers: number[] }[] = [];
  while (Date.now() < stop) {
    rows = await observer.$queryRawUnsafe<{ pid: number; query: string; blockers: number[] }[]>(
      `SELECT pid,query,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%OAuthAttempt%'`,
    );
    if (rows.length >= count) {
      console.info(JSON.stringify({ attemptWaiters: rows }));
      return rows;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error(`Wanted ${count} attempt waiters; got ${rows.length}`);
}
const noDeadlock = (results: unknown) =>
  expect(JSON.stringify(results)).not.toMatch(/deadlock|40P01/i);
describe('current-source author characterization; linking off, folds enabled only in synthetic probes', () => {
  beforeEach(async () => {
    assertTestDatabase();
    config.demo = false;
    config.appUrl = 'http://localhost:3000';
    process.env.WALLET_LINKS_ENABLED = 'false';
    process.env.ACCOUNT_FOLDS_ENABLED = 'true';
    process.env.X_CLIENT_ID = 'synthetic-review-client';
    process.env.X_CLIENT_SECRET = 'synthetic-review-secret';
    await truncateAll(db);
  });
  afterAll(async () => {
    delete process.env.WALLET_LINKS_ENABLED;
    delete process.env.ACCOUNT_FOLDS_ENABLED;
    delete process.env.X_CLIENT_ID;
    delete process.env.X_CLIENT_SECRET;
    await Promise.all([db.$disconnect(), observer.$disconnect(), locker.$disconnect()]);
  });

  it('REQUIRED: claimed later attempt and callback-internal fold must not invert ordered attempts', async () => {
    const drop = await walletOnly(),
      keep = await keeper();
    const low = await attempt(drop, 'a'.repeat(64)),
      high = await attempt(drop, 'f'.repeat(64));
    const gate = await hold(
      'SELECT 1 FROM "OAuthAttempt" WHERE "stateHash"=$1 FOR UPDATE',
      low.stateHash,
    );
    let callback: ReturnType<typeof outcome> | undefined,
      merge: ReturnType<typeof outcome> | undefined;
    try {
      merge = outcome(
        db.$transaction((tx) => absorbAccount(tx, keep.id, drop.id), { timeout: 20000 }),
      );
      await blocked(gate.pid, 'OAuthAttempt');
      callback = outcome(
        completeConnection(high, { id: keep.xId, username: keep.xId, name: keep.xId }),
      );
      await waiters(2);
      gate.release();
      await gate.held;
      const results = await Promise.all([merge, callback]);
      console.info(JSON.stringify({ callbackOwnFold: { results } }));
      expect(results.filter((x) => x?.ok)).toHaveLength(1);
      expect(await db.user.findUnique({ where: { id: drop.id } })).toBeNull();
      expect(
        await db.walletIdentity.count({
          where: { address: drop.primary.address, userId: keep.id },
        }),
      ).toBe(1);
      expect(await db.moderationEvent.count({ where: { action: 'account:merge' } })).toBe(1);
      expect(await db.oAuthAttempt.count({ where: { userId: drop.id } })).toBe(0);
      expect(await db.session.count({ where: { userId: drop.id } })).toBe(0);
      noDeadlock(results);
    } finally {
      gate.release();
      await gate.held;
      await Promise.allSettled([callback, merge]);
    }
  }, 15000);
  it('REQUIRED: two real callbacks claiming different attempts must not deadlock in their folds', async () => {
    const drop = await walletOnly(),
      keepA = await keeper(),
      keepB = await keeper(),
      low = await attempt(drop, 'a'.repeat(64)),
      high = await attempt(drop, 'f'.repeat(64));
    const gate = await hold(
      'SELECT 1 FROM "OAuthAttempt" WHERE "stateHash"=$1 FOR UPDATE',
      high.stateHash,
    );
    let p: ReturnType<typeof outcome> | undefined, q: ReturnType<typeof outcome> | undefined;
    try {
      q = outcome(
        completeConnection(high, { id: keepB.xId, username: keepB.xId, name: keepB.xId }),
      );
      await blocked(gate.pid, 'OAuthAttempt');
      p = outcome(completeConnection(low, { id: keepA.xId, username: keepA.xId, name: keepA.xId }));
      await waiters(2);
      gate.release();
      await gate.held;
      const results = await Promise.all([p, q]);
      console.info(JSON.stringify({ twoCallbackFolds: { results } }));
      expect(results.filter((x) => x?.ok)).toHaveLength(1);
      expect(await db.user.count()).toBe(2);
      expect(await db.user.findUnique({ where: { id: drop.id } })).toBeNull();
      expect(await db.walletIdentity.count({ where: { address: drop.primary.address } })).toBe(1);
      expect(await db.xAccount.count()).toBe(2);
      expect(await db.moderationEvent.count({ where: { action: 'account:merge' } })).toBe(1);
      expect(await db.session.count({ where: { userId: drop.id } })).toBe(0);
      noDeadlock(results);
    } finally {
      gate.release();
      await gate.held;
      await Promise.allSettled([p, q]);
    }
  }, 15000);
  it('REQUIRED: expired-attempt sweep cannot deadlock with ordered merge attempt locks', async () => {
    const drop = await walletOnly(),
      keep = await keeper();
    const high = await attempt(drop, 'f'.repeat(64), true);
    await attempt(drop, 'a'.repeat(64), true);
    const baseline = {
      users: await db.user.findMany({ orderBy: { id: 'asc' } }),
      wallets: await db.walletIdentity.findMany({ orderBy: { address: 'asc' } }),
      sessions: await db.session.findMany({ orderBy: { tokenHash: 'asc' } }),
    };
    const gate = await hold(
      'SELECT 1 FROM "OAuthAttempt" WHERE "stateHash"=$1 FOR UPDATE',
      high.stateHash,
    );
    let sweep: ReturnType<typeof outcome> | undefined,
      merge: ReturnType<typeof outcome> | undefined;
    try {
      sweep = outcome(startAttempt(null));
      await blocked(gate.pid, 'OAuthAttempt');
      merge = outcome(
        db.$transaction((tx) => absorbAccount(tx, keep.id, drop.id), { timeout: 20000 }),
      );
      await waiters(2);
      gate.release();
      await gate.held;
      const results = await Promise.all([sweep, merge]);
      console.info(JSON.stringify({ expiredSweepVsMerge: { results } }));
      if (!results[1]?.ok) {
        expect({
          users: await db.user.findMany({ orderBy: { id: 'asc' } }),
          wallets: await db.walletIdentity.findMany({ orderBy: { address: 'asc' } }),
          sessions: await db.session.findMany({ orderBy: { tokenHash: 'asc' } }),
        }).toEqual(baseline);
        expect(await db.moderationEvent.count({ where: { action: 'account:merge' } })).toBe(0);
      }
      noDeadlock(results);
    } finally {
      gate.release();
      await gate.held;
      await Promise.allSettled([sweep, merge]);
    }
  }, 15000);
});
