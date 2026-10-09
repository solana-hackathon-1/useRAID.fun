// Frozen subset of src/lib/wallet-auth.ts at 12cb3a4 (before any wallet-link change); an
// intentional old-binary compatibility fixture. It reproduces only the database statements the
// legacy sign-in, link and rotate paths run AFTER signature verification and challenge
// consumption. Signature checks, the 7-day cooldown and the pending-transfer check are omitted
// because they do not touch wallet subject ownership. Do not "improve" it: its value is that it
// knows nothing about WalletLink and therefore models an application binary that predates it.
import type { Prisma } from '@prisma/client';

export class LegacyConflict extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// Anonymous sign-in: resolve by WalletIdentity.address, otherwise create a wallet-only account.
export async function legacySignIn(tx: Prisma.TransactionClient, address: string) {
  const known = await tx.walletIdentity.findUnique({ where: { address } });
  let userId = known?.userId;
  if (!userId) {
    const user = await tx.user.create({
      data: { handle: `${address.slice(0, 4)}…${address.slice(-4)}` },
    });
    userId = user.id;
    await tx.walletIdentity.create({ data: { address, userId } });
  }
  const owner = await tx.user.findUniqueOrThrow({ where: { id: userId } });
  if (owner.suspended) throw new LegacyConflict(403, 'This account is suspended.');
  return userId;
}

// Signed-in link of a wallet nobody owns yet (one wallet per account).
export async function legacyLink(tx: Prisma.TransactionClient, userId: string, address: string) {
  const known = await tx.walletIdentity.findUnique({ where: { address } });
  if (known) throw new LegacyConflict(409, 'Wallet belongs to another account.');
  const currentWallet = await tx.walletIdentity.findUnique({ where: { userId } });
  if (currentWallet) throw new LegacyConflict(409, 'Account already has a wallet.');
  await tx.walletIdentity.create({ data: { address, userId } });
}

// Payout wallet rotation: delete and re-create the single row after the balance advisory lock.
export async function legacyRotate(tx: Prisma.TransactionClient, userId: string, address: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`balance:${userId}`}, 0))`;
  const current = await tx.walletIdentity.findUnique({ where: { userId } });
  if (!current) throw new LegacyConflict(409, 'Connect a wallet first.');
  if (current.address === address) throw new LegacyConflict(409, 'This is already your wallet.');
  if (await tx.walletIdentity.findUnique({ where: { address } }))
    throw new LegacyConflict(409, 'Wallet belongs to another account.');
  const now = new Date();
  await tx.walletIdentity.delete({ where: { userId } });
  await tx.walletIdentity.create({
    data: { address, userId, previousAddress: current.address, rotatedAt: now },
  });
}
