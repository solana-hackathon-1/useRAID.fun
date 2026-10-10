import { randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { PublicKey } from '@solana/web3.js';
import { db } from './db';
import { config } from './config';
import { hash, random, HttpError } from './auth-primitives';
import { absorbAccount, isEmptyAccount } from './account-merge';
import { lockBalance } from './usdc';
import { IdentityLinkError, lookupWalletLink } from '../identity-link';
import {
  createPrismaIdentityTransaction,
  classifyIdentityStorageFailure,
} from './identity-storage-adapter';
import { runCommandTransaction } from './command-receipts-adapter';
import { SIWS_CHAIN_ID } from './wallet-link-proof';

// Retry only whole transactions, preserving the same challenge and pre-generated session token.
// Never expose trigger/driver detail (including a reserved wallet address) to HTTP or logs.
async function walletTransaction(work: (tx: Prisma.TransactionClient) => Promise<void>) {
  try {
    await runCommandTransaction(db, (_port, tx) => work(tx));
  } catch (error) {
    if (classifyIdentityStorageFailure(error).code === 'UNIQUE_CONFLICT')
      throw new HttpError(409, 'Wallet belongs to another account.');
    if (error instanceof IdentityLinkError) {
      if (
        error.code === 'RETRY_TRANSACTION' ||
        error.code === 'STORAGE_UNAVAILABLE' ||
        error.code === 'STORAGE_CONTRACT'
      )
        throw new HttpError(503, 'Wallet sign-in unavailable. Please try again.');
      throw new HttpError(401, 'Wallet sign-in unavailable.');
    }
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'Wallet sign-in unavailable. Please try again.');
  }
}

export function walletAddress(value: string) {
  try {
    const key = new PublicKey(value);
    if (key.toBase58() !== value) throw new Error('Non-canonical address');
    return key;
  } catch {
    throw new HttpError(400, 'Enter a valid Solana wallet address.');
  }
}
export type ChallengePurpose = 'signin' | 'link' | 'rotate';
const STATEMENTS: Record<ChallengePurpose, string> = {
  signin: 'Sign in to useRAID.fun.',
  link: 'Link this wallet to your useRAID.fun account.',
  rotate: 'Change the wallet on your useRAID.fun account. Withdrawals pause for 24 hours.',
};
const ROTATION_COOLDOWN_MS = 7 * 86400000;
// Canonical Sign-In With Solana text, so wallets recognise it and warn when another site relays it.
export async function createWalletChallenge(
  address: string,
  currentUserId?: string,
  purpose: ChallengePurpose = currentUserId ? 'link' : 'signin',
) {
  walletAddress(address);
  if ((purpose === 'signin') === !!currentUserId)
    throw new HttpError(400, 'Invalid wallet challenge.');
  const url = new URL(config.appUrl);
  const nonce = randomBytes(24).toString('base64url');
  const issued = new Date();
  const expires = new Date(+issued + 5 * 60000);
  const message = `${url.host} wants you to sign in with your Solana account:\n${address}\n\n${STATEMENTS[purpose]}\n\nURI: ${url.origin}\nVersion: 1\nChain ID: ${SIWS_CHAIN_ID}\nNonce: ${nonce}\nIssued At: ${issued.toISOString()}\nExpiration Time: ${expires.toISOString()}`;
  const digest = hash(message);
  await db.walletChallenge.create({
    data: { digest, address, message, userId: currentUserId ?? null, expiresAt: expires },
  });
  return { digest, message };
}
function decodeSignature(signature: string) {
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(signature);
  } catch {
    throw new HttpError(400, 'Invalid wallet signature.');
  }
  if (bytes.length !== 64) throw new HttpError(400, 'Invalid wallet signature.');
  return bytes;
}
// The challenge is bound to the signer state and purpose it was issued for, so a signature
// collected for an anonymous sign-in cannot link or rotate a wallet, and the reverse.
async function consumeChallenge(
  tx: Prisma.TransactionClient,
  digest: string,
  address: string,
  bytes: Uint8Array,
  currentUserId: string | undefined,
  purpose: ChallengePurpose,
) {
  const key = walletAddress(address);
  const attempt = await tx.walletChallenge.findUnique({ where: { digest } });
  if (
    !attempt ||
    attempt.address !== address ||
    attempt.consumedAt ||
    attempt.expiresAt <= new Date() ||
    (attempt.userId ?? undefined) !== currentUserId ||
    attempt.message.split('\n')[3] !== STATEMENTS[purpose] ||
    !nacl.sign.detached.verify(new TextEncoder().encode(attempt.message), bytes, key.toBytes())
  )
    throw new HttpError(401, 'Wallet challenge expired or signature invalid.');
  const consumed = await tx.walletChallenge.updateMany({
    where: { digest, consumedAt: null, expiresAt: { gt: new Date() } },
    data: { consumedAt: new Date() },
  });
  if (consumed.count !== 1) throw new HttpError(409, 'Wallet challenge already used.');
}
export async function verifyWalletChallenge(
  digest: string,
  signature: string,
  address: string,
  currentUserId?: string,
  currentSessionHash?: string,
) {
  walletAddress(address);
  const bytes = decodeSignature(signature);
  const sessionToken = random();
  await walletTransaction(async (tx) => {
    await consumeChallenge(
      tx,
      digest,
      address,
      bytes,
      currentUserId,
      currentUserId ? 'link' : 'signin',
    );
    const linked = await lookupWalletLink(createPrismaIdentityTransaction(tx), address);
    if (linked) {
      // A linked credential cannot enter the legacy two-account fold path, including when revoked.
      if (currentUserId && linked.accountId !== currentUserId)
        throw new HttpError(409, 'Wallet belongs to another account.');
      if (linked.status !== 'ACTIVE' || linked.networkIdentity !== SIWS_CHAIN_ID)
        throw new HttpError(401, 'Wallet sign-in unavailable.');
      if (linked.accountSuspended) throw new HttpError(403, 'This account is suspended.');
    }
    const known = await tx.walletIdentity.findUnique({ where: { address } });
    let userId = currentUserId || linked?.accountId || known?.userId;
    if (currentUserId && known && known.userId !== currentUserId) {
      // A wallet-only account with no activity can be folded into the signed-in X account, or the reverse.
      const [currentWallet, owner] = await Promise.all([
        tx.walletIdentity.findUnique({ where: { userId: currentUserId } }),
        tx.user.findUniqueOrThrow({ where: { id: known.userId } }),
      ]);
      if (currentWallet || owner.xId)
        throw new HttpError(409, 'Wallet belongs to another account.');
      if (await isEmptyAccount(tx, owner.id)) {
        await absorbAccount(tx, currentUserId, owner.id);
        userId = currentUserId;
      } else if (await isEmptyAccount(tx, currentUserId)) {
        await absorbAccount(tx, owner.id, currentUserId);
        userId = owner.id;
      } else
        throw new HttpError(
          409,
          'This wallet already has its own useRAID account with activity. Sign in with the wallet instead.',
        );
    } else if (currentUserId && !known && !linked) {
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
    const owner = await tx.user.findUniqueOrThrow({ where: { id: userId! } });
    if (owner.suspended) throw new HttpError(403, 'This account is suspended.');
    // Signing in again must not widen what the old session could do, nor narrow an X session.
    const previous = currentSessionHash
      ? await tx.session.findUnique({ where: { tokenHash: currentSessionHash } })
      : null;
    if (
      currentSessionHash &&
      previous &&
      (previous.userId === userId || previous.userId === currentUserId)
    )
      await tx.session.deleteMany({ where: { tokenHash: currentSessionHash } });
    await tx.session.create({
      data: {
        tokenHash: hash(sessionToken),
        userId: userId!,
        // Only a live authenticated session for the resolved account can preserve X authority.
        via:
          currentUserId && previous && previous.userId === userId && previous.expiresAt > new Date()
            ? previous.via
            : 'wallet',
        expiresAt: new Date(Date.now() + 7 * 86400000),
      },
    });
  });
  return sessionToken;
}
// Re-points payouts to a new verified wallet. The X account is the second factor, so a stolen
// wallet-only session cannot redirect funds, and withdrawals pause briefly afterwards.
export async function rotateWallet(
  userId: string,
  digest: string,
  signature: string,
  address: string,
) {
  walletAddress(address);
  const bytes = decodeSignature(signature);
  await walletTransaction(async (tx) => {
    await lockBalance(tx, userId);
    await consumeChallenge(tx, digest, address, bytes, userId, 'rotate');
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.suspended) throw new HttpError(403, 'This account is suspended.');
    if (!(await tx.xAccount.findUnique({ where: { userId } })))
      throw new HttpError(403, 'Connect X before changing your wallet.');
    const current = await tx.walletIdentity.findUnique({ where: { userId } });
    if (!current) throw new HttpError(409, 'Connect a wallet first.');
    if (current.address === address) throw new HttpError(409, 'This is already your wallet.');
    if (
      (await lookupWalletLink(createPrismaIdentityTransaction(tx), address)) ||
      (await tx.walletIdentity.findUnique({ where: { address } }))
    )
      throw new HttpError(409, 'Wallet belongs to another account.');
    const now = new Date();
    const open = await tx.usdcTransfer.count({
      where: {
        userId,
        OR: [
          { kind: 'WITHDRAWAL', status: 'REQUESTED' },
          { kind: 'DEPOSIT', status: 'AWAITING_TRANSFER', expiresAt: { gt: now } },
        ],
      },
    });
    if (open) throw new HttpError(409, 'Finish pending deposits and withdrawals first.');
    if (current.rotatedAt && +now - +current.rotatedAt < ROTATION_COOLDOWN_MS)
      throw new HttpError(429, 'You can change your wallet once every 7 days.');
    await tx.walletIdentity.delete({ where: { userId } });
    await tx.walletIdentity.create({
      data: { address, userId, previousAddress: current.address, rotatedAt: now },
    });
    await tx.moderationEvent.create({
      data: {
        actorId: userId,
        action: 'wallet-rotated',
        targetId: userId,
        reason: `${current.address} -> ${address}`,
      },
    });
  });
}
