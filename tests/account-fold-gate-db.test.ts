import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient, type OAuthAttempt } from '@prisma/client';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { db } from '../src/lib/db';
import { config } from '../src/lib/config';
import { hash } from '../src/lib/auth';
import { createWalletChallenge, verifyWalletChallenge } from '../src/lib/wallet-auth';
import { claimAttempt, completeConnection, startAttempt } from '../src/lib/x-oauth';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

// Launch gate: automatic folding of a duplicate activity-free account (X callback and wallet
// link) is OFF unless ACCOUNT_FOLDS_ENABLED is exactly "true". The fold path takes OAuth-attempt,
// User and X-identity locks in orders that independent review reproduced as PostgreSQL
// deadlocks (40P01) and stale-state merges. With the gate off the duplicate is refused with the
// existing "already belongs to another account" responses and nothing is merged; ordinary X
// sign-in, wallet sign-in and linking a NEW wallet or a NEW X identity are unchanged.
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
const outcome = (promise: Promise<unknown>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: { status?: number; code?: string; message?: string }) => ({
      ok: false as const,
      status: error.status,
      code: error.code,
      message: error.message,
    }),
  );
let counter = 0;

integration('account fold launch gate (default off)', () => {
  beforeAll(() => {
    assertTestDatabase();
    config.demo = false;
    config.appUrl = 'http://localhost:3000';
    vi.stubEnv('X_CLIENT_ID', 'fixture-client');
    vi.stubEnv('X_CLIENT_SECRET', 'fixture-secret');
  });
  beforeEach(async () => {
    delete process.env.ACCOUNT_FOLDS_ENABLED;
    await truncateAll(db);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await Promise.all([db.$disconnect(), observer.$disconnect(), locker.$disconnect()]);
  });

  async function walletSignIn(w: Wallet, currentUserId?: string, sessionHash?: string) {
    const c = await createWalletChallenge(w.address, currentUserId);
    return verifyWalletChallenge(
      c.digest,
      w.sign(c.message),
      w.address,
      currentUserId,
      sessionHash,
    );
  }
  async function walletOnly() {
    const w = pair();
    const token = await walletSignIn(w);
    const s = await db.session.findUniqueOrThrow({ where: { tokenHash: hash(token) } });
    return { id: s.userId, wallet: w, sessionHash: hash(token) };
  }
  async function xAccount(xId = `fold-x-${++counter}`) {
    const user = await db.user.create({ data: { xId, handle: xId } });
    await db.xAccount.create({
      data: { userId: user.id, xUserId: xId, username: xId, displayName: xId },
    });
    const sessionHash = hash(`session-${xId}`);
    await db.session.create({
      data: {
        userId: user.id,
        tokenHash: sessionHash,
        via: 'x',
        expiresAt: new Date(Date.now() + 1e6),
      },
    });
    return { id: user.id, xId, sessionHash };
  }
  async function connectX(sessionHash: string | null, id: string) {
    const { state } = await startAttempt(sessionHash);
    const attempt = await claimAttempt(state, sessionHash);
    return completeConnection(attempt, { id, username: id, name: id });
  }
  const snapshot = async () => ({
    users: await db.user.findMany({ orderBy: { id: 'asc' } }),
    wallets: await db.walletIdentity.findMany({ orderBy: { address: 'asc' } }),
    xAccounts: await db.xAccount.findMany({ orderBy: { userId: 'asc' } }),
  });

  it('refuses an X callback that would fold two accounts and changes nothing', async () => {
    const x = await xAccount();
    const w = await walletOnly();
    const before = await snapshot();
    expect(await outcome(connectX(w.sessionHash, x.xId))).toMatchObject({
      ok: false,
      code: 'identity',
    });
    expect(await snapshot()).toEqual(before);
    expect(await db.moderationEvent.count({ where: { action: 'account:merge' } })).toBe(0);
  });

  it('refuses a wallet link that would fold two accounts, keeps the challenge unconsumed', async () => {
    const w = await walletOnly();
    const x = await xAccount();
    const before = await snapshot();
    const c = await createWalletChallenge(w.wallet.address, x.id);
    expect(
      await outcome(
        verifyWalletChallenge(
          c.digest,
          w.wallet.sign(c.message),
          w.wallet.address,
          x.id,
          x.sessionHash,
        ),
      ),
    ).toMatchObject({ ok: false, status: 409 });
    expect(await snapshot()).toEqual(before);
    expect(
      (await db.walletChallenge.findUniqueOrThrow({ where: { digest: c.digest } })).consumedAt,
    ).toBeNull();
    expect(await db.moderationEvent.count({ where: { action: 'account:merge' } })).toBe(0);
  });

  it('still lets a wallet-only account connect a NEW X identity and an X account link a NEW wallet', async () => {
    const w = await walletOnly();
    await connectX(w.sessionHash, 'brand-new-x');
    expect(await db.user.findUniqueOrThrow({ where: { id: w.id } })).toMatchObject({
      xId: 'brand-new-x',
    });
    const x = await xAccount();
    const fresh = pair();
    await walletSignIn(fresh, x.id, x.sessionHash);
    expect(await db.walletIdentity.findUniqueOrThrow({ where: { userId: x.id } })).toMatchObject({
      address: fresh.address,
    });
    expect(await db.user.count()).toBe(2);
  });

  it('a first X connection racing a wallet-link fold attempt neither deadlocks nor merges', async () => {
    const w = await walletOnly();
    const x = await xAccount();
    const { state } = await startAttempt(w.sessionHash);
    const attempt: OAuthAttempt = await claimAttempt(state, w.sessionHash);
    const c = await createWalletChallenge(w.wallet.address, x.id);
    // Hold the claimed attempt so the callback parks inside its transaction, then start the link.
    let ready!: () => void;
    let release!: () => void;
    const started = new Promise<void>((r) => (ready = r));
    const gate = new Promise<void>((r) => (release = r));
    const held = locker.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT 1 FROM "OAuthAttempt" WHERE "stateHash" = $1 FOR UPDATE',
        attempt.stateHash,
      );
      ready();
      await gate;
    });
    await started;
    let callback: ReturnType<typeof outcome> | undefined;
    let link: ReturnType<typeof outcome> | undefined;
    try {
      callback = outcome(completeConnection(attempt, { id: 'first-x', username: 'f', name: 'F' }));
      link = outcome(
        verifyWalletChallenge(
          c.digest,
          w.wallet.sign(c.message),
          w.wallet.address,
          x.id,
          x.sessionHash,
        ),
      );
      // Gate off: the link refuses without waiting. Gate on (fold attempt): both queue on locks.
      let linkSettled = false;
      void link.then(() => (linkSettled = true));
      const stop = Date.now() + 5000;
      while (Date.now() < stop && !linkSettled) {
        const [row] = await observer.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`,
        );
        if (row.n >= 2) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      release();
      await held;
      const results = await Promise.all([callback, link]);
      expect(JSON.stringify(results)).not.toMatch(/deadlock|40P01/i);
      expect(results).toMatchObject([{ ok: true }, { ok: false, status: 409 }]);
      expect(await db.user.findUniqueOrThrow({ where: { id: w.id } })).toMatchObject({
        xId: 'first-x',
      });
      expect(await db.walletIdentity.findUniqueOrThrow({ where: { userId: w.id } })).toMatchObject({
        address: w.wallet.address,
      });
      expect(await db.user.findUniqueOrThrow({ where: { id: x.id } })).toMatchObject({
        xId: x.xId,
      });
      expect(await db.moderationEvent.count({ where: { action: 'account:merge' } })).toBe(0);
    } finally {
      release();
      await held;
      await Promise.allSettled([callback, link]);
    }
  }, 15000);

  it('only the exact value "true" enables folding', async () => {
    const { accountFoldsEnabled } = await import('../src/lib/config');
    for (const value of [undefined, '', 'false', 'TRUE', '1', 'yes'])
      expect(accountFoldsEnabled({ ACCOUNT_FOLDS_ENABLED: value })).toBe(false);
    expect(accountFoldsEnabled({ ACCOUNT_FOLDS_ENABLED: 'true' })).toBe(true);
  });
});
