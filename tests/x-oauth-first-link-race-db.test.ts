import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { db } from '../src/lib/db';
import { config } from '../src/lib/config';
import { hash } from '../src/lib/auth';
import { isAdmin } from '../src/lib/admins';
import { startAttempt, claimAttempt, completeConnection, lockIdentity } from '../src/lib/x-oauth';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
// Two callbacks for the same account that has no X identity yet, each carrying its own session and a
// different verified X profile. Both read the account before either commits; the identity must bind once.
integration('first X identity binding under concurrent callbacks (PostgreSQL)', () => {
  const plain = { id: '1001', username: 'plain', name: 'Plain' };
  const privileged = { id: '2002', username: 'privileged', name: 'Privileged' };
  let lockDb: PrismaClient, observer: PrismaClient;
  beforeAll(() => {
    assertTestDatabase();
    // Lock holders and observations cannot compete with the two callbacks for the app pool.
    const fixtureUrl = new URL(process.env.DATABASE_URL!);
    fixtureUrl.searchParams.set('connection_limit', '3');
    lockDb = new PrismaClient({
      datasourceUrl: fixtureUrl.toString(),
      transactionOptions: { timeout: 30000, maxWait: 10000 },
    });
    fixtureUrl.searchParams.set('connection_limit', '1');
    observer = new PrismaClient({ datasourceUrl: fixtureUrl.toString() });
    config.demo = false;
    config.appUrl = 'http://localhost:3000';
    vi.stubEnv('X_CLIENT_ID', 'fixture-client');
    vi.stubEnv('X_CLIENT_SECRET', 'fixture-secret');
    vi.stubEnv('X_ADMIN_USER_ID', privileged.id);
  });
  beforeEach(async () => {
    await truncateAll(db);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await Promise.all([db.$disconnect(), lockDb?.$disconnect(), observer?.$disconnect()]);
  });

  async function walletAccount() {
    const user = await db.user.create({ data: { handle: 'wallet-user' } });
    const sessions = ['wallet-session-1', 'wallet-session-2'].map(hash);
    for (const tokenHash of sessions)
      await db.session.create({
        data: { tokenHash, userId: user.id, via: 'wallet', expiresAt: new Date(Date.now() + 36e5) },
      });
    return { user, sessions };
  }
  async function claimed(sessionHash: string) {
    const { state } = await startAttempt(sessionHash);
    return claimAttempt(state, sessionHash);
  }
  // Holds the per-identity advisory lock so a callback reads the account, then waits at its lock.
  async function holdIdentityLock(xId: string) {
    let open!: () => void;
    let held!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const locked = new Promise<void>((resolve) => (held = resolve));
    const finished = lockDb.$transaction(
      async (tx) => {
        await lockIdentity(tx, xId);
        held();
        await gate;
      },
      { timeout: 30000, maxWait: 10000 },
    );
    await Promise.race([locked, finished]);
    return () => {
      open();
      return finished;
    };
  }
  async function holdRowLock(userId: string) {
    let open!: () => void;
    let held!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const locked = new Promise<void>((resolve) => (held = resolve));
    const finished = lockDb.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR NO KEY UPDATE`;
        held();
        await gate;
      },
      { timeout: 30000, maxWait: 10000 },
    );
    await Promise.race([locked, finished]);
    return () => {
      open();
      return finished;
    };
  }
  async function waitUntilRowBlocked(count: number) {
    for (let i = 0; i < 200; i++) {
      const rows = await observer.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND wait_event IN ('transactionid', 'tuple')
          AND datname = current_database()`;
      if (Number(rows[0].n) >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw Error('callbacks never blocked on the account row');
  }
  async function waitUntilBlocked(count: number) {
    for (let i = 0; i < 200; i++) {
      const rows = await observer.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND wait_event = 'advisory' AND datname = current_database()`;
      if (Number(rows[0].n) >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw Error('callbacks never reached the identity lock');
  }
  async function race(order: 'simultaneous' | 'overlapping-update' | (typeof plain)[]) {
    const { user, sessions } = await walletAccount();
    const attempts = [await claimed(sessions[0]), await claimed(sessions[1])];
    const profiles = [plain, privileged];
    const releases: (() => Promise<void>)[] = [];
    let releaseRow: (() => Promise<void>) | undefined;
    let callbacks: Promise<{ token: string } | { error: unknown }>[] = [];
    try {
      releases.push(await holdIdentityLock(plain.id));
      releases.push(await holdIdentityLock(privileged.id));
      callbacks = [
        completeConnection(attempts[0], plain),
        completeConnection(attempts[1], privileged),
      ].map((p) =>
        p.then(
          (token) => ({ token }),
          (error: unknown) => ({ error }),
        ),
      );
      await waitUntilBlocked(2);
      if (order === 'overlapping-update') {
        // Both callbacks block on the account row; the loser UPDATE is re-evaluated after commit.
        releaseRow = await holdRowLock(user.id);
        await Promise.all(releases.map((release) => release()));
        await waitUntilRowBlocked(2);
        await releaseRow();
      } else if (order === 'simultaneous') await Promise.all(releases.map((release) => release()));
      else
        for (const first of order) {
          const at = profiles.indexOf(first);
          await releases[at]();
          await callbacks[at];
        }
      const results = await Promise.all(callbacks);
      return { user, results, profiles, sessions, attempts };
    } finally {
      // Open every owned gate before awaiting; then drain callbacks before the next TRUNCATE.
      await Promise.all([releaseRow?.(), ...releases.map((release) => release())]);
      await Promise.all(callbacks);
    }
  }

  async function expectSingleBinding(
    outcome: Awaited<ReturnType<typeof race>>,
    expectedWinner?: typeof plain,
  ) {
    const { user, results, profiles, sessions, attempts } = outcome;
    expect(
      (
        await db.$queryRaw<
          { level: string }[]
        >`SELECT current_setting('transaction_isolation') AS level`
      )[0].level,
    ).toBe('read committed');
    const winners = results.flatMap((r, i) => ('token' in r ? [{ profile: profiles[i], r }] : []));
    const losers = results.flatMap((r, i) => ('error' in r ? [{ profile: profiles[i], r }] : []));
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].r.error).toMatchObject({ code: 'identity' });
    const winner = winners[0].profile;
    const loser = losers[0].profile;
    if (expectedWinner) expect(winner.id).toBe(expectedWinner.id);
    // The permanent identity is the winner's and was never replaced.
    const stored = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.xId).toBe(winner.id);
    const xAccounts = await db.xAccount.findMany();
    expect(xAccounts).toHaveLength(1);
    expect(xAccounts[0]).toMatchObject({ userId: user.id, xUserId: winner.id });
    expect(await db.user.count()).toBe(1);
    // The refused callback rolled back: its wallet session is intact and its claimed attempt was not consumed away.
    const at = (p: typeof plain) => profiles.indexOf(p);
    expect(
      await db.session.findUnique({ where: { tokenHash: sessions[at(loser)] } }),
    ).not.toBeNull();
    expect(await db.session.findUnique({ where: { tokenHash: sessions[at(winner)] } })).toBeNull();
    expect(
      await db.oAuthAttempt.findUnique({ where: { stateHash: attempts[at(loser)].stateHash } }),
    ).toMatchObject({ consumedAt: expect.any(Date) });
    expect(
      await db.oAuthAttempt.findUnique({ where: { stateHash: attempts[at(winner)].stateHash } }),
    ).toBeNull();
    // The only X session belongs to the identity bound to the account, and only the allowlisted one is admin.
    const xSessions = await db.session.findMany({ where: { via: 'x' }, include: { user: true } });
    expect(xSessions).toHaveLength(1);
    expect(xSessions[0].tokenHash).toBe(hash(winners[0].r.token as string));
    expect(xSessions[0].user.xId).toBe(winner.id);
    expect(isAdmin(xSessions[0].user)).toBe(winner.id === privileged.id);
    expect(stored.role === 'ADMIN').toBe(winner.id === privileged.id);
  }

  it('a stale second callback cannot replace the identity bound by an earlier non-admin callback', async () => {
    await expectSingleBinding(await race([plain, privileged]), plain);
  });
  it('a stale second callback cannot replace the identity bound by an earlier admin callback', async () => {
    await expectSingleBinding(await race([privileged, plain]), privileged);
  });
  it('callbacks released together bind exactly one identity', async () => {
    await expectSingleBinding(await race('simultaneous'));
  });
  it("overlapping row updates: the callback blocked on the winner's row is re-evaluated and refused", async () => {
    await expectSingleBinding(await race('overlapping-update'));
  });
  it('two sessions confirming the same X identity both succeed and keep one binding', async () => {
    const { user, sessions } = await walletAccount();
    const attempts = [await claimed(sessions[0]), await claimed(sessions[1])];
    const results = await Promise.allSettled(attempts.map((a) => completeConnection(a, plain)));
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).xId).toBe(plain.id);
    expect(await db.xAccount.count()).toBe(1);
  });
});
