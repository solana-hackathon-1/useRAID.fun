import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { db } from '../src/lib/db';
import { config } from '../src/lib/config';
import { linkVerifiedWallet } from '../src/identity-link';
import { createPrismaIdentityTransaction } from '../src/lib/identity-storage-adapter';
import { fixtureLinkInput } from './helpers/wallet-link-fixtures';
import { hash } from '../src/lib/auth-primitives';
import {
  createWalletChallenge,
  linkAdditionalWallet,
  rotateWallet,
  verifyWalletChallenge,
} from '../src/lib/wallet-auth';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
integration(
  'B2b existing-credential sign-in (released behavior; new linking remains gated)',
  () => {
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
    async function account(options: { suspended?: boolean } = {}) {
      const n = `b2b-${++counter}`;
      const user = await db.user.create({ data: { xId: n, handle: n } });
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
          via: 'x',
          expiresAt: new Date(Date.now() + 1e6),
        },
      });
      const sessionHash = hash(raw);
      if (options.suspended)
        await db.user.update({ where: { id: user.id }, data: { suspended: true } });
      return { user, primary, sessionHash };
    }
    async function linked(a: { user: { id: string }; sessionHash: string }) {
      const w = pair();
      process.env.WALLET_LINKS_ENABLED = 'true';
      const c = await createWalletChallenge(w.address, a.user.id, 'link-additional');
      await linkAdditionalWallet(
        a.user.id,
        c.digest,
        w.sign(c.message),
        w.address,
        a.sessionHash,
        `request-${++counter}`,
      );
      return w;
    }
    const signIn = async (w: Wallet, userId?: string) => {
      const c = await createWalletChallenge(w.address, userId);
      return verifyWalletChallenge(c.digest, w.sign(c.message), w.address, userId);
    };
    const state = async () => ({
      users: await db.user.count(),
      wallets: await db.walletIdentity.count(),
      links: await db.walletLink.count(),
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

    it('signs in as the linking account with a wallet session when the switch is on', async () => {
      const a = await account();
      const w = await linked(a);
      const before = await state();
      const token = await signIn(w);
      const session = await db.session.findUniqueOrThrow({ where: { tokenHash: hash(token) } });
      expect(session).toMatchObject({ userId: a.user.id, via: 'wallet' });
      expect(await state()).toEqual(before);
      expect(
        await db.walletIdentity.findUniqueOrThrow({ where: { userId: a.user.id } }),
      ).toMatchObject({
        address: a.primary.address,
      });
    });

    it('keeps an existing linked credential usable when new linking is switched off', async () => {
      const a = await account();
      const w = await linked(a);
      delete process.env.WALLET_LINKS_ENABLED;
      const before = await state();
      const sessions = await db.session.count();
      const c = await createWalletChallenge(w.address);
      const token = await verifyWalletChallenge(c.digest, w.sign(c.message), w.address);
      expect(
        await db.session.findUniqueOrThrow({ where: { tokenHash: hash(token) } }),
      ).toMatchObject({ userId: a.user.id, via: 'wallet' });
      expect(await state()).toEqual(before);
      expect(await db.session.count()).toBe(sessions + 1);
      expect(
        (await db.walletChallenge.findUniqueOrThrow({ where: { digest: c.digest } })).consumedAt,
      ).not.toBeNull();
      expect(
        await db.walletIdentity.findUniqueOrThrow({ where: { userId: a.user.id } }),
      ).toMatchObject({ address: a.primary.address });
    });

    it('never signs in through a revoked link, with the switch on or off', async () => {
      const a = await account();
      const w = await linked(a);
      await db.walletLink.updateMany({
        where: { address: w.address },
        data: { status: 'REVOKED', revokedAt: new Date() },
      });
      for (const flag of ['true', undefined]) {
        if (flag) process.env.WALLET_LINKS_ENABLED = flag;
        else delete process.env.WALLET_LINKS_ENABLED;
        const before = await state();
        await expect(signIn(w)).rejects.toMatchObject({ status: 401 });
        expect(await state()).toEqual(before);
      }
    });

    it('gives revoked and wrong-network reservations the same released denial without changing state', async () => {
      const a = await account();
      const w = await linked(a);
      delete process.env.WALLET_LINKS_ENABLED;
      await db.walletLink.updateMany({
        where: { address: w.address },
        data: { status: 'REVOKED', revokedAt: new Date() },
      });
      // A separate immutable reservation; never reactivate or change a revoked row's network.
      const foreignNetwork = pair();
      const fixture = fixtureLinkInput(a.user.id, foreignNetwork.address);
      const subject = { networkIdentity: 'other-test-network', address: foreignNetwork.address };
      await db.$transaction((tx) =>
        linkVerifiedWallet(createPrismaIdentityTransaction(tx), {
          ...fixture,
          subject,
          proof: { ...fixture.proof, subject: { kind: 'WALLET', ...subject } },
          policy: {
            domain: 'localhost:3000',
            uri: 'http://localhost:3000',
            walletNetworks: ['other-test-network'],
            providers: [],
          },
        }),
      );
      const before = await state();
      const sessions = await db.session.count();
      const revoked = await signIn(w).catch((e) => e);
      const wrongNetwork = await signIn(foreignNetwork).catch((e) => e);
      expect([revoked.status, wrongNetwork.status]).toEqual([401, 401]);
      expect(revoked.message).toBe(wrongNetwork.message);
      expect(revoked.message).not.toContain(a.user.id);
      expect(revoked.message).not.toContain(w.address);
      expect(await state()).toEqual(before);
      expect(await db.session.count()).toBe(sessions);
    });

    it('serializes two fresh signed challenges into one account with two independent wallet sessions', async () => {
      const fresh = pair();
      const users = await db.user.count();
      const [c1, c2] = await Promise.all([
        createWalletChallenge(fresh.address),
        createWalletChallenge(fresh.address),
      ]);
      const tokens = await Promise.all([
        verifyWalletChallenge(c1.digest, fresh.sign(c1.message), fresh.address),
        verifyWalletChallenge(c2.digest, fresh.sign(c2.message), fresh.address),
      ]);
      expect(new Set(tokens).size).toBe(2);
      const owner = await db.walletIdentity.findUniqueOrThrow({
        where: { address: fresh.address },
      });
      for (const token of tokens)
        expect(
          await db.session.findUniqueOrThrow({ where: { tokenHash: hash(token) } }),
        ).toMatchObject({ userId: owner.userId, via: 'wallet' });
      expect(await db.user.count()).toBe(users + 1);
      expect(await db.walletIdentity.count({ where: { address: fresh.address } })).toBe(1);
      expect(
        await db.walletChallenge.count({
          where: { digest: { in: [c1.digest, c2.digest] }, consumedAt: { not: null } },
        }),
      ).toBe(2);
    });

    it('denies a suspended owner with no session', async () => {
      const a = await account();
      const w = await linked(a);
      await db.user.update({ where: { id: a.user.id }, data: { suspended: true } });
      const sessions = await db.session.count();
      await expect(signIn(w)).rejects.toMatchObject({ status: 403 });
      expect(await db.session.count()).toBe(sessions);
    });

    it('allows same-account reauthentication while denying foreign legacy links and payout rotation', async () => {
      const owner = await account();
      const other = await account();
      const w = await linked(owner);
      const before = await state();
      const foreign = await createWalletChallenge(w.address, other.user.id);
      await expect(
        verifyWalletChallenge(foreign.digest, w.sign(foreign.message), w.address, other.user.id),
      ).rejects.toMatchObject({ status: 409 });
      const own = await createWalletChallenge(w.address, owner.user.id);
      const token = await verifyWalletChallenge(
        own.digest,
        w.sign(own.message),
        w.address,
        owner.user.id,
        owner.sessionHash,
      );
      expect(
        await db.session.findUniqueOrThrow({ where: { tokenHash: hash(token) } }),
      ).toMatchObject({ userId: owner.user.id, via: 'x' });
      expect(await db.session.findUnique({ where: { tokenHash: owner.sessionHash } })).toBeNull();
      // Rotation of another account's payout wallet onto the linked address.
      const r = await createWalletChallenge(w.address, other.user.id, 'rotate');
      await expect(
        rotateWallet(other.user.id, r.digest, w.sign(r.message), w.address),
      ).rejects.toMatchObject({ status: 409 });
      expect(await state()).toEqual(before);
      expect(
        await db.walletIdentity.findUniqueOrThrow({ where: { userId: other.user.id } }),
      ).toMatchObject({
        address: other.primary.address,
      });
    });

    it('keeps ordinary primary-wallet sign-in and unknown-wallet sign-up unchanged', async () => {
      const a = await account();
      process.env.WALLET_LINKS_ENABLED = 'true';
      const token = await signIn(a.primary);
      expect(
        await db.session.findUniqueOrThrow({ where: { tokenHash: hash(token) } }),
      ).toMatchObject({ userId: a.user.id });
      const fresh = pair();
      const users = await db.user.count();
      await signIn(fresh);
      expect(await db.user.count()).toBe(users + 1);
    });
  },
);
