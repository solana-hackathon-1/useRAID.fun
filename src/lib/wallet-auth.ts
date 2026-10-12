import { Prisma } from '@prisma/client';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { PublicKey } from '@solana/web3.js';
import { db } from './db';
import { accountFoldsEnabled, config, walletLinksEnabled } from './config';
import { hash, random, HttpError } from './auth-primitives';
import { absorbAccount, isEmptyAccount } from './account-merge';
import { lockBalance } from './usdc';
import {
  IdentityLinkError,
  lookupWalletLink,
  linkVerifiedWallet,
  publicWalletLink,
  type IdentityLinkCode,
  type PublicWalletLink,
} from '../identity-link';
import {
  createPrismaIdentityTransaction,
  classifyIdentityStorageFailure,
} from './identity-storage-adapter';
import { runCommandTransaction } from './command-receipts-adapter';
import { deriveWalletLinkProof } from './wallet-link-proof';
import { siwsNonce } from './siws-nonce';
import {
  LINK_ADDITIONAL_STATEMENT,
  siwsChainId,
  WALLET_CHALLENGE_STATEMENTS,
  walletChallengeMatchesOrigin,
} from './wallet-challenge-contract';
import { walletSessionAuthority, type WalletSessionObservation } from './wallet-session-authority';

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
export type ChallengePurpose = 'signin' | 'link' | 'rotate' | 'link-additional';
// 'link-additional' exists only behind the server switch; legacy vocabulary bytes are unchanged.
const STATEMENTS: Record<ChallengePurpose, string> = {
  ...WALLET_CHALLENGE_STATEMENTS,
  'link-additional': LINK_ADDITIONAL_STATEMENT,
};
const ROTATION_COOLDOWN_MS = 7 * 86400000;
// Canonical Sign-In With Solana text, so wallets recognise it and warn when another site relays it.
export async function createWalletChallenge(
  address: string,
  currentUserId?: string,
  purpose: ChallengePurpose = currentUserId ? 'link' : 'signin',
) {
  walletAddress(address);
  if (!Object.hasOwn(STATEMENTS, purpose) || (purpose === 'signin') === !!currentUserId)
    throw new HttpError(400, 'Invalid wallet challenge.');
  if (purpose === 'link-additional') {
    if (!walletLinksEnabled()) throw new HttpError(400, 'Invalid wallet challenge.');
    await requireConnectedX(db, currentUserId!);
  }
  const url = new URL(config.appUrl);
  const chainId = siwsChainId();
  const nonce = siwsNonce();
  const issued = new Date();
  const expires = new Date(+issued + 5 * 60000);
  const message = `${url.host} wants you to sign in with your Solana account:\n${address}\n\n${STATEMENTS[purpose]}\n\nURI: ${url.origin}\nVersion: 1\nChain ID: ${chainId}\nNonce: ${nonce}\nIssued At: ${issued.toISOString()}\nExpiration Time: ${expires.toISOString()}`;
  const digest = hash(message);
  await db.walletChallenge.create({
    data: { digest, address, message, userId: currentUserId ?? null, expiresAt: expires },
  });
  return { digest, message };
}
async function requireConnectedX(
  client: Pick<Prisma.TransactionClient, 'xAccount'>,
  userId: string,
) {
  // Server-confirmed X linkage, the same condition rotateWallet applies (DEC-2026-10-09-01).
  if (!(await client.xAccount.findUnique({ where: { userId } })))
    throw new HttpError(403, 'Connect X before adding a sign-in wallet.');
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
function challengeChainId(message: string): 'devnet' | 'mainnet' {
  const line = message.split('\n')[7];
  if (line === 'Chain ID: devnet') return 'devnet';
  if (line === 'Chain ID: mainnet') return 'mainnet';
  throw new HttpError(401, 'Wallet challenge expired or signature invalid.');
}
async function consumeChallenge(
  tx: Prisma.TransactionClient,
  digest: string,
  address: string,
  bytes: Uint8Array,
  currentUserId: string | undefined,
  purpose: ChallengePurpose,
) {
  // Fail closed on invalid deployment configuration without rewriting a pending signed intent.
  siwsChainId();
  const key = walletAddress(address);
  const attempt = await tx.walletChallenge.findUnique({ where: { digest } });
  if (
    !attempt ||
    attempt.address !== address ||
    attempt.consumedAt ||
    attempt.expiresAt <= new Date() ||
    (attempt.userId ?? undefined) !== currentUserId ||
    hash(attempt.message) !== digest ||
    !walletChallengeMatchesOrigin(attempt.message, config.appUrl) ||
    attempt.message.split('\n')[3] !== STATEMENTS[purpose] ||
    !nacl.sign.detached.verify(new TextEncoder().encode(attempt.message), bytes, key.toBytes())
  )
    throw new HttpError(401, 'Wallet challenge expired or signature invalid.');
  challengeChainId(attempt.message);
  const consumed = await tx.walletChallenge.updateMany({
    where: { digest, consumedAt: null, expiresAt: { gt: new Date() } },
    data: { consumedAt: new Date() },
  });
  if (consumed.count !== 1) throw new HttpError(409, 'Wallet challenge already used.');
  return attempt;
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
    const attempt = await consumeChallenge(
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
      if (
        linked.status !== 'ACTIVE' ||
        linked.networkIdentity !== challengeChainId(attempt.message)
      )
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
      // Folding is gated off for launch (see accountFoldsEnabled): refuse and change nothing.
      if (!accountFoldsEnabled())
        throw new HttpError(
          409,
          'This wallet already belongs to another useRAID account. Sign in with that wallet instead.',
        );
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
    // Atomically claim only this account's prior session so concurrent logout/expiry or
    // another account's token cannot transfer authority into the replacement session.
    const previous = currentSessionHash
      ? await tx.$queryRaw<WalletSessionObservation[]>`
          DELETE FROM "Session"
          WHERE "tokenHash" = ${currentSessionHash} AND "userId" = ${userId!}
          RETURNING "userId", "via", "expiresAt"
        `
      : [];
    const now = new Date();
    await tx.session.create({
      data: {
        tokenHash: hash(sessionToken),
        userId: userId!,
        via: walletSessionAuthority(previous[0], currentUserId, userId!, now),
        expiresAt: new Date(now.getTime() + 7 * 86400000),
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

const LINK_LIMITS = { maxActiveLinks: 5, maxTotalLinks: 20 } as const;
const LINK_HTTP: Partial<Record<IdentityLinkCode, [number, string]>> = {
  AUTHENTICATION_REQUIRED: [401, 'Sign in to continue.'],
  WRONG_ACTOR: [403, 'Not allowed.'],
  FORBIDDEN: [403, 'Not allowed.'],
  ACCOUNT_RESTRICTED: [403, 'This account is suspended.'],
  PROOF_INVALID: [401, 'Wallet challenge expired or signature invalid.'],
  UNSUPPORTED_IDENTITY: [400, 'Unsupported wallet.'],
  IDENTITY_CONFLICT: [409, 'This wallet cannot be added to your account.'],
  IDENTITY_REVOKED: [409, 'This wallet cannot be added to your account.'],
  PRIMARY_WALLET_REQUIRED: [409, 'Connect a wallet first.'],
  LINK_LIMIT_REACHED: [409, 'Wallet limit reached.'],
  RETRY_TRANSACTION: [503, 'Try again.'],
};
// Linearization boundary for linking (owner clarification 2026-10-10): the CURRENT session must be
// the caller's own, live by the database clock, and carry X authority (via === 'x'), on an account
// whose X connection still exists. Read after the subject/account locks and row-locked FOR SHARE
// until commit, so a revoke, expiry or X disconnect that committed while this command waited is
// seen, and one arriving later waits for this commit (an already-decided link is not undone).
// The clock is read in its own statement AFTER both row locks are granted: a clock evaluated in
// the locking SELECT (or captured before either wait) predates the wait, so a session that
// expired while the command was blocked would still look live.
async function observeLinkAuthority(
  tx: Prisma.TransactionClient,
  userId: string,
  sessionHash: string | undefined,
) {
  const [session] = sessionHash
    ? await tx.$queryRaw<{ userId: string; via: string; expiresAt: Date }[]>`
        SELECT "userId", "via", "expiresAt"
        FROM "Session" WHERE "tokenHash" = ${sessionHash} FOR SHARE`
    : [];
  if (!session || session.userId !== userId) throw new IdentityLinkError('AUTHENTICATION_REQUIRED');
  const x = await tx.$queryRaw<{ one: number }[]>`
    SELECT 1 AS "one" FROM "XAccount" WHERE "userId" = ${userId} FOR SHARE`;
  const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS "now"`;
  if (session.expiresAt <= now) throw new IdentityLinkError('AUTHENTICATION_REQUIRED');
  if (session.via !== 'x') throw new IdentityLinkError('FORBIDDEN');
  if (x.length !== 1) throw new IdentityLinkError('FORBIDDEN');
  return {
    session: {
      accountId: session.userId,
      state: 'ACTIVE',
      expiresAt: session.expiresAt.toISOString(),
    },
    now: now.toISOString(),
  };
}
function linkFailure(error: unknown): HttpError | null {
  if (!(error instanceof IdentityLinkError)) return null;
  const [status, message] = LINK_HTTP[error.code] ?? [503, 'Wallet linking is unavailable.'];
  return new HttpError(status, message);
}
// Adds a sign-in wallet to the caller's own account. The payout wallet never changes. Requires the
// server switch, a connected X account, the caller's own live session read here (never client
// asserted) and a fresh single-use proof from the additional wallet.
export async function linkAdditionalWallet(
  userId: string,
  digest: string,
  signature: string,
  address: string,
  currentSessionHash: string | undefined,
  requestId: string,
): Promise<PublicWalletLink> {
  if (!walletLinksEnabled()) throw new HttpError(400, 'Invalid wallet challenge.');
  walletAddress(address);
  const bytes = decodeSignature(signature);
  const url = new URL(config.appUrl);
  try {
    const linked = await db.$transaction(
      async (tx) => {
        const attempt = await consumeChallenge(
          tx,
          digest,
          address,
          bytes,
          userId,
          'link-additional',
        );
        const chainId = challengeChainId(attempt.message);
        return linkVerifiedWallet(createPrismaIdentityTransaction(tx), {
          accountId: userId,
          actorAccountId: userId,
          requestId,
          subject: { networkIdentity: chainId, address },
          proof: deriveWalletLinkProof(attempt, { signatureVerified: true }),
          // Authority is observed by the module under the subject and account locks (below).
          observeAuthority: () => observeLinkAuthority(tx, userId, currentSessionHash),
          policy: {
            domain: url.host,
            uri: url.origin,
            walletNetworks: [chainId],
            providers: [],
          },
          limits: LINK_LIMITS,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    return publicWalletLink(linked);
  } catch (error) {
    throw linkFailure(error) ?? error;
  }
}
