import { randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { PublicKey } from '@solana/web3.js';
import { db } from './db';
import { config } from './config';
import { hash, random, HttpError } from './auth-primitives';

export function walletAddress(value: string) {
  try {
    const key = new PublicKey(value);
    if (key.toBase58() !== value) throw new Error('Non-canonical address');
    return key;
  } catch {
    throw new HttpError(400, 'Enter a valid Solana wallet address.');
  }
}
export async function createWalletChallenge(address: string) {
  walletAddress(address);
  const origin = new URL(config.appUrl).origin;
  const nonce = randomBytes(24).toString('base64url');
  const message = `${origin} wants you to sign in to useRAID.fun\nWallet: ${address}\nNonce: ${nonce}\nExpires: ${new Date(Date.now() + 5 * 60000).toISOString()}`;
  const digest = hash(message);
  await db.walletChallenge.create({
    data: { digest, address, message, expiresAt: new Date(Date.now() + 5 * 60000) },
  });
  return { digest, message };
}
export async function verifyWalletChallenge(
  digest: string,
  signature: string,
  address: string,
  currentUserId?: string,
) {
  const key = walletAddress(address);
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(signature);
  } catch {
    throw new HttpError(400, 'Invalid wallet signature.');
  }
  if (bytes.length !== 64) throw new HttpError(400, 'Invalid wallet signature.');
  const sessionToken = random();
  await db.$transaction(async (tx) => {
    const attempt = await tx.walletChallenge.findUnique({ where: { digest } });
    if (
      !attempt ||
      attempt.address !== address ||
      attempt.consumedAt ||
      attempt.expiresAt <= new Date() ||
      !nacl.sign.detached.verify(new TextEncoder().encode(attempt.message), bytes, key.toBytes())
    )
      throw new HttpError(401, 'Wallet challenge expired or signature invalid.');
    const consumed = await tx.walletChallenge.updateMany({
      where: { digest, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) throw new HttpError(409, 'Wallet challenge already used.');
    const known = await tx.walletIdentity.findUnique({ where: { address } });
    if (currentUserId && known && known.userId !== currentUserId)
      throw new HttpError(409, 'Wallet belongs to another account.');
    let userId = currentUserId || known?.userId;
    if (currentUserId && !known) {
      const currentWallet = await tx.walletIdentity.findUnique({
        where: { userId: currentUserId },
      });
      if (currentWallet) throw new HttpError(409, 'Account already has a wallet.');
      await tx.walletIdentity.create({ data: { address, userId: currentUserId } });
    } else if (!userId) {
      const user = await tx.user.create({
        data: { handle: `${address.slice(0, 4)}…${address.slice(-4)}` },
      });
      userId = user.id;
      await tx.walletIdentity.create({ data: { address, userId } });
    }
    await tx.session.create({
      data: {
        tokenHash: hash(sessionToken),
        userId: userId!,
        expiresAt: new Date(Date.now() + 7 * 86400000),
      },
    });
  });
  return sessionToken;
}
