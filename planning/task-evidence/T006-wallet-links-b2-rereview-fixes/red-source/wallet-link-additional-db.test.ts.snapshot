import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { db } from '../src/lib/db';
import { config } from '../src/lib/config';
import { hash } from '../src/lib/auth-primitives';
import {
  createWalletChallenge,
  linkAdditionalWallet,
  rotateWallet,
  verifyWalletChallenge,
} from '../src/lib/wallet-auth';
import { LINK_ADDITIONAL_STATEMENT } from '../src/lib/wallet-challenge-contract';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
integration('B2a additional wallet link command (default-off, connected X)', () => {
  const pair = () => {
    const kp = Keypair.generate();
    return {
      address: kp.publicKey.toBase58(),
      sign: (message: string) =>
        bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey)),
    };
  };
  type Wallet = ReturnType<typeof pair>;
  let counter = 0;
  async function account(options: { x?: boolean; suspended?: boolean } = {}) {
    const n = `b2a-${++counter}`;
    const user = await db.user.create({
      data: { xId: options.x === false ? null : n, handle: n, suspended: options.suspended },
    });
    if (options.x !== false)
      await db.xAccount.create({
        data: { userId: user.id, xUserId: n, username: n, displayName: n },
      });
    const primary = pair();
    await db.walletIdentity.create({ data: { address: primary.address, userId: user.id } });
    const raw = `token-${n}`;
    await db.session.create({
      data: {
        tokenHash: hash(raw),
        userId: user.id,
        via: options.x === false ? 'wallet' : 'x',
        expiresAt: new Date(Date.now() + 1e6),
      },
    });
    return { user, primary, sessionHash: hash(raw) };
  }
  const challenge = (w: Wallet, userId: string) =>
    createWalletChallenge(w.address, userId, 'link-additional');
  async function link(
    a: { user: { id: string }; sessionHash: string },
    w: Wallet,
    requestId = `request-${++counter}`,
  ) {
    const c = await challenge(w, a.user.id);
    return linkAdditionalWallet(
      a.user.id,
      c.digest,
      w.sign(c.message),
      w.address,
      a.sessionHash,
      requestId,
    );
  }
  const counts = async () => ({
    links: await db.walletLink.count(),
    participants: await db.participant.count(),
    challenges: await db.walletChallenge.count({ where: { consumedAt: { not: null } } }),
    wallets: await db.walletIdentity.count(),
  });

  beforeAll(async () => {
    assertTestDatabase();
    config.demo = false;
    config.appUrl = 'http://localhost:3000';
    await truncateAll(db);
  });
  beforeEach(async () => {
    delete process.env.WALLET_LINKS_ENABLED;
    await db.walletChallenge.deleteMany();
  });
  afterEach(() => {
    delete process.env.WALLET_LINKS_ENABLED;
  });
  afterAll(() => db.$disconnect());

  it('is off by default for challenge issue and verification and writes nothing', async () => {
    const a = await account();
    const w = pair();
    const before = await counts();
    await expect(challenge(w, a.user.id)).rejects.toMatchObject({ status: 400 });
    process.env.WALLET_LINKS_ENABLED = 'true';
    const c = await challenge(w, a.user.id);
    delete process.env.WALLET_LINKS_ENABLED;
    await expect(
      linkAdditionalWallet(
        a.user.id,
        c.digest,
        w.sign(c.message),
        w.address,
        a.sessionHash,
        'request-off',
      ),
    ).rejects.toMatchObject({ status: 400 });
    process.env.WALLET_LINKS_ENABLED = 'maybe';
    await expect(challenge(w, a.user.id)).rejects.toMatchObject({ status: 400 });
    expect((await counts()).links).toBe(before.links);
    expect(
      (await db.walletChallenge.findUniqueOrThrow({ where: { digest: c.digest } })).consumedAt,
    ).toBeNull();
  });

  describe('enabled', () => {
    beforeEach(() => {
      process.env.WALLET_LINKS_ENABLED = 'true';
    });

    it('links a fresh wallet for a connected-X account: same participant, primary unchanged, challenge consumed', async () => {
      const a = await account();
      const w = pair();
      const c = await challenge(w, a.user.id);
      expect(c.message.split('\n')[3]).toBe(LINK_ADDITIONAL_STATEMENT);
      const result = await linkAdditionalWallet(
        a.user.id,
        c.digest,
        w.sign(c.message),
        w.address,
        a.sessionHash,
        'request-ok',
      );
      expect(result).toEqual({
        address: w.address,
        networkIdentity: 'mainnet',
        status: 'ACTIVE',
        alreadyLinked: false,
      });
      const stored = await db.walletLink.findFirstOrThrow({ where: { address: w.address } });
      expect(stored).toMatchObject({
        accountId: a.user.id,
        status: 'ACTIVE',
        linkActorAccountId: a.user.id,
        linkRequestId: 'request-ok',
      });
      expect(
        await db.walletIdentity.findUniqueOrThrow({ where: { userId: a.user.id } }),
      ).toMatchObject({ address: a.primary.address });
      expect(await db.participant.count({ where: { accountId: a.user.id } })).toBe(1);
      expect(
        (await db.walletChallenge.findUniqueOrThrow({ where: { digest: c.digest } })).consumedAt,
      ).not.toBeNull();
      expect(await db.session.count({ where: { tokenHash: a.sessionHash } })).toBe(1);
    });

    it('denies an account with no connected X at issue and verify; the challenge stays unconsumed', async () => {
      const x = await account();
      const w = pair();
      const c = await challenge(w, x.user.id);
      const bare = await account({ x: false });
      await expect(challenge(w, bare.user.id)).rejects.toMatchObject({ status: 403 });
      // A stored challenge for this account cannot bypass the server-side X check.
      const stolen = await db.walletChallenge.update({
        where: { digest: c.digest },
        data: { userId: bare.user.id },
      });
      await expect(
        linkAdditionalWallet(
          bare.user.id,
          stolen.digest,
          w.sign(c.message),
          w.address,
          bare.sessionHash,
          'request-bare',
        ),
      ).rejects.toMatchObject({ status: 403 });
      expect(await db.walletLink.count({ where: { accountId: bare.user.id } })).toBe(0);
      expect(
        (await db.walletChallenge.findUniqueOrThrow({ where: { digest: stolen.digest } }))
          .consumedAt,
      ).toBeNull();
    });

    it("requires the caller's own live session", async () => {
      const a = await account();
      const other = await account();
      const w = pair();
      for (const [label, session] of [
        ['foreign', other.sessionHash],
        ['unknown', hash('no-such-session')],
        ['absent', undefined],
      ] as const) {
        const c = await challenge(w, a.user.id);
        await expect(
          linkAdditionalWallet(
            a.user.id,
            c.digest,
            w.sign(c.message),
            w.address,
            session,
            `request-${label}`,
          ),
        ).rejects.toMatchObject({ status: 401 });
      }
      await db.session.update({
        where: { tokenHash: a.sessionHash },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const c = await challenge(w, a.user.id);
      await expect(
        linkAdditionalWallet(
          a.user.id,
          c.digest,
          w.sign(c.message),
          w.address,
          a.sessionHash,
          'request-expired',
        ),
      ).rejects.toMatchObject({ status: 401 });
      expect(await db.walletLink.count({ where: { accountId: a.user.id } })).toBe(0);
    });

    it("rejects replay, another account's challenge, a wrong-purpose challenge and a bad signature", async () => {
      const a = await account();
      const b = await account();
      const w = pair();
      const c = await challenge(w, a.user.id);
      await linkAdditionalWallet(
        a.user.id,
        c.digest,
        w.sign(c.message),
        w.address,
        a.sessionHash,
        'request-1',
      );
      await expect(
        linkAdditionalWallet(
          a.user.id,
          c.digest,
          w.sign(c.message),
          w.address,
          a.sessionHash,
          'request-2',
        ),
      ).rejects.toMatchObject({ status: 401 });
      const w2 = pair();
      const mine = await challenge(w2, a.user.id);
      await expect(
        linkAdditionalWallet(
          b.user.id,
          mine.digest,
          w2.sign(mine.message),
          w2.address,
          b.sessionHash,
          'request-3',
        ),
      ).rejects.toMatchObject({ status: 401 });
      const legacy = await createWalletChallenge(w2.address, a.user.id, 'link');
      await expect(
        linkAdditionalWallet(
          a.user.id,
          legacy.digest,
          w2.sign(legacy.message),
          w2.address,
          a.sessionHash,
          'request-4',
        ),
      ).rejects.toMatchObject({ status: 401 });
      await expect(
        linkAdditionalWallet(
          a.user.id,
          mine.digest,
          pair().sign(mine.message),
          w2.address,
          a.sessionHash,
          'request-5',
        ),
      ).rejects.toMatchObject({ status: 401 });
      expect(await db.walletLink.count({ where: { accountId: a.user.id } })).toBe(1);
      expect(await db.walletLink.count({ where: { accountId: b.user.id } })).toBe(0);
      // The additional-link signature cannot be used as a legacy link, sign-in or rotation.
      const w3 = pair();
      const extra = await challenge(w3, a.user.id);
      await expect(
        verifyWalletChallenge(extra.digest, w3.sign(extra.message), w3.address, a.user.id),
      ).rejects.toMatchObject({ status: 401 });
      await expect(
        rotateWallet(a.user.id, extra.digest, w3.sign(extra.message), w3.address),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('returns one sanitized conflict for a foreign primary, a foreign link and an own revoked link', async () => {
      const a = await account();
      const b = await account();
      const foreignLink = pair();
      await link(b, foreignLink);
      const revoked = pair();
      await link(a, revoked);
      await db.walletLink.updateMany({
        where: { address: revoked.address },
        data: { status: 'REVOKED', revokedAt: new Date() },
      });
      const codes: string[] = [];
      for (const w of [b.primary, foreignLink, revoked]) {
        const c = await challenge(w, a.user.id);
        const error = await linkAdditionalWallet(
          a.user.id,
          c.digest,
          w.sign(c.message),
          w.address,
          a.sessionHash,
          `request-c${codes.length}`,
        ).catch((e) => e);
        codes.push(`${error.status}:${error.message}`);
        expect(error.message).not.toContain(b.user.id);
        expect(error.message).not.toContain(w.address);
      }
      expect(new Set(codes).size).toBe(1);
      expect(codes[0]).toMatch(/^409:/);
    });

    it('denies a suspended account and rolls the whole attempt back', async () => {
      const a = await account();
      const w = pair();
      const c = await challenge(w, a.user.id);
      await db.user.update({ where: { id: a.user.id }, data: { suspended: true } });
      const before = await counts();
      await expect(
        linkAdditionalWallet(
          a.user.id,
          c.digest,
          w.sign(c.message),
          w.address,
          a.sessionHash,
          'request-suspended',
        ),
      ).rejects.toMatchObject({ status: 403 });
      expect(await counts()).toEqual(before);
      expect(
        (await db.walletChallenge.findUniqueOrThrow({ where: { digest: c.digest } })).consumedAt,
      ).toBeNull();
    });
  });
});
