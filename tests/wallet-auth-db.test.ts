import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { db } from '../src/lib/db';
import { config } from '../src/lib/config';
import { createWalletChallenge, verifyWalletChallenge } from '../src/lib/wallet-auth';
import { hash } from '../src/lib/auth';
import { assertTestDatabase } from './helpers/db-guard';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
integration('wallet ownership PostgreSQL invariants', () => {
  const key = Keypair.generate();
  const address = key.publicKey.toBase58();
  let ownerId = '';
  beforeAll(() => {
    assertTestDatabase();
    config.demo = false;
    config.appUrl = 'http://localhost:3000';
  });
  afterAll(async () => {
    await db.walletChallenge.deleteMany({ where: { address } });
    if (ownerId) await db.user.deleteMany({ where: { id: ownerId } });
    await db.user.deleteMany({ where: { xId: 'wallet-conflict-test' } });
    await db.$disconnect();
  });
  const sign = (message: string) =>
    bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), key.secretKey));
  it('creates wallet-only user, consumes challenge once, and rejects stale challenge', async () => {
    const challenge = await createWalletChallenge(address);
    expect(challenge.message).toContain('http://localhost:3000');
    const token = await verifyWalletChallenge(challenge.digest, sign(challenge.message), address);
    const session = await db.session.findUniqueOrThrow({ where: { tokenHash: hash(token) } });
    ownerId = session.userId;
    expect((await db.user.findUniqueOrThrow({ where: { id: ownerId } })).xId).toBeNull();
    await expect(
      verifyWalletChallenge(challenge.digest, sign(challenge.message), address),
    ).rejects.toMatchObject({ status: 401 });
    const expired = await createWalletChallenge(address);
    await db.walletChallenge.update({
      where: { digest: expired.digest },
      data: { expiresAt: new Date(0) },
    });
    await expect(
      verifyWalletChallenge(expired.digest, sign(expired.message), address),
    ).rejects.toMatchObject({ status: 401 });
  });
  it('refuses linking wallet already owned by another X identity', async () => {
    const other = await db.user.create({ data: { xId: 'wallet-conflict-test', handle: 'other' } });
    const challenge = await createWalletChallenge(address);
    await expect(
      verifyWalletChallenge(challenge.digest, sign(challenge.message), address, other.id),
    ).rejects.toMatchObject({ status: 409 });
    expect(await db.walletIdentity.findUnique({ where: { address } })).toMatchObject({
      userId: ownerId,
    });
  });
});
