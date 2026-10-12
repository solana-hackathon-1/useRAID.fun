import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { db } from '../src/lib/db';
import { config } from '../src/lib/config';
import { createWalletChallenge, rotateWallet, verifyWalletChallenge } from '../src/lib/wallet-auth';
import { hash } from '../src/lib/auth-primitives';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
integration('stored wallet challenge application origin (T007 AC02)', () => {
  const appUrl = config.appUrl;
  const pair = () => {
    const key = Keypair.generate();
    return {
      address: key.publicKey.toBase58(),
      sign: (message: string) =>
        bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), key.secretKey)),
    };
  };
  beforeAll(() => assertTestDatabase());
  beforeEach(async () => {
    config.appUrl = 'https://raid.example';
    vi.stubEnv('USDC_NETWORK', 'devnet');
    await truncateAll(db);
  });
  afterEach(() => {
    config.appUrl = appUrl;
    vi.unstubAllEnvs();
  });
  afterAll(() => db.$disconnect());

  async function snapshot() {
    return {
      users: await db.user.findMany({ orderBy: { id: 'asc' } }),
      wallets: await db.walletIdentity.findMany({ orderBy: { address: 'asc' } }),
      sessions: await db.session.findMany({ orderBy: { tokenHash: 'asc' } }),
      audit: await db.moderationEvent.findMany({ orderBy: { id: 'asc' } }),
      challenges: await db.walletChallenge.findMany({ orderBy: { digest: 'asc' } }),
    };
  }
  async function owner() {
    const user = await db.user.create({
      data: { xId: 'synthetic-origin-owner', handle: 'fixture' },
    });
    await db.xAccount.create({
      data: { userId: user.id, xUserId: user.xId!, username: 'fixture', displayName: 'fixture' },
    });
    await db.session.create({
      data: {
        userId: user.id,
        tokenHash: hash('synthetic-origin-session'),
        via: 'x',
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    return user;
  }

  it('rejects an otherwise valid sign-in signature issued for the previous domain without mutation', async () => {
    const wallet = pair();
    const challenge = await createWalletChallenge(wallet.address);
    const before = await snapshot();
    config.appUrl = 'https://new-raid.example';
    await expect(
      verifyWalletChallenge(challenge.digest, wallet.sign(challenge.message), wallet.address),
    ).rejects.toMatchObject({ status: 401 });
    expect(await snapshot()).toEqual(before);
  });

  it('rejects a link signed for another application port and preserves the existing session', async () => {
    const user = await owner();
    const wallet = pair();
    config.appUrl = 'http://localhost:3013';
    const challenge = await createWalletChallenge(wallet.address, user.id);
    const before = await snapshot();
    config.appUrl = 'http://localhost:3014';
    await expect(
      verifyWalletChallenge(
        challenge.digest,
        wallet.sign(challenge.message),
        wallet.address,
        user.id,
        hash('synthetic-origin-session'),
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(await snapshot()).toEqual(before);
  });

  it('rejects a rotation signed for another URI scheme and preserves payout ownership and audit', async () => {
    const user = await owner();
    const primary = pair();
    await db.walletIdentity.create({ data: { userId: user.id, address: primary.address } });
    const next = pair();
    config.appUrl = 'http://raid.example';
    const challenge = await createWalletChallenge(next.address, user.id, 'rotate');
    const before = await snapshot();
    config.appUrl = 'https://raid.example';
    await expect(
      rotateWallet(user.id, challenge.digest, next.sign(challenge.message), next.address),
    ).rejects.toMatchObject({ status: 401 });
    expect(await snapshot()).toEqual(before);
  });

  it('allows a current-origin challenge when only the configured URL path changes and rejects replay', async () => {
    const wallet = pair();
    const challenge = await createWalletChallenge(wallet.address);
    config.appUrl = 'https://raid.example/creator/account?preview=1';
    const token = await verifyWalletChallenge(
      challenge.digest,
      wallet.sign(challenge.message),
      wallet.address,
    );
    const session = await db.session.findUniqueOrThrow({ where: { tokenHash: hash(token) } });
    expect(
      await db.walletIdentity.findUnique({ where: { address: wallet.address } }),
    ).toMatchObject({ userId: session.userId });
    expect(
      (await db.walletChallenge.findUniqueOrThrow({ where: { digest: challenge.digest } }))
        .consumedAt,
    ).not.toBeNull();
    const after = await snapshot();
    await expect(
      verifyWalletChallenge(challenge.digest, wallet.sign(challenge.message), wallet.address),
    ).rejects.toMatchObject({ status: 401 });
    expect(await snapshot()).toEqual(after);
  });
});
