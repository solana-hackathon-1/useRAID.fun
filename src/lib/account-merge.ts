import type { Prisma } from '@prisma/client';
import { hasHumanParticipant } from '../identity-storage';
import { createPrismaIdentityTransaction } from './identity-storage-adapter';
import { prepareIdentity, identityWriter, lockAdvisory } from './identity-protocol';
import { lockResource, requireIdentityLocks, type IdentityLockCapability } from '../identity-locks';
import { HttpError } from './errors';

export async function lockIdentity(tx: Prisma.TransactionClient, xId: string) {
  await lockAdvisory(tx, lockResource('x-auth', xId));
}
// Existing activity categories plus canonical identity protection. Media retention
// remains governed by its existing uploader policy; this is not a rights inventory.
export async function isEmptyAccount(tx: Prisma.TransactionClient, userId: string) {
  const user = await tx.user.findUnique({ where: { id: userId } });
  if (!user || user.role === 'ADMIN' || user.suspended) return false;
  if (await hasHumanParticipant(createPrismaIdentityTransaction(tx), userId)) return false;
  const where = { userId };
  const counts = await Promise.all([
    tx.raid.count({ where: { creatorId: userId } }),
    tx.tokenLaunch.count({ where }),
    tx.rewardEnrollment.count({ where }),
    tx.raidEnrollment.count({ where }),
    tx.balanceEntry.count({ where }),
    tx.usdcTransfer.count({ where }),
    tx.usdcAllocation.count({ where }),
  ]);
  return counts.every((n) => n === 0);
}
// Moves the identities of an activity-free account onto another one and deletes it.
export async function absorbAccount(
  tx: Prisma.TransactionClient,
  keepId: string,
  dropId: string,
  alreadyLocked?: IdentityLockCapability,
) {
  if (keepId === dropId) throw new HttpError(409, 'Cannot merge an account into itself.');
  // A2: deny known activity before strong roots. Unlocked observations never authorize a move.
  if (!alreadyLocked && !(await isEmptyAccount(tx, dropId)))
    throw new HttpError(409, 'Only an activity-free account can be merged.');
  const observed = await tx.user.findUnique({ where: { id: dropId }, select: { xId: true } });
  const locks =
    alreadyLocked ??
    (await prepareIdentity(tx, {
      accounts: [
        { id: keepId, mode: observed?.xId ? 'UPDATE' : 'NO KEY UPDATE' },
        { id: dropId, mode: 'UPDATE' },
      ],
      balances: [keepId, dropId],
    }));
  await requireIdentityLocks(createPrismaIdentityTransaction(tx), locks, {
    accounts: [
      { id: dropId, mode: 'UPDATE' },
      { id: keepId, mode: observed?.xId ? 'UPDATE' : 'NO KEY UPDATE' },
    ],
    children: [
      'OAuthAttempt',
      'XAccount',
      'Session',
      'WalletIdentity',
      'Participant',
      'WalletLink',
    ],
  });
  const writes = identityWriter(tx, locks);
  const [keep, drop] = await Promise.all([
    tx.user.findUniqueOrThrow({ where: { id: keepId } }),
    tx.user.findUniqueOrThrow({ where: { id: dropId } }),
  ]);
  if (drop.xId !== (observed?.xId ?? null))
    throw new HttpError(409, 'Account identity changed during the merge; try again.');
  if (!(await isEmptyAccount(tx, dropId)))
    throw new HttpError(409, 'Only an activity-free account can be merged.');
  const [keepWallet, dropWallet] = await Promise.all([
    tx.walletIdentity.findUnique({ where: { userId: keepId } }),
    tx.walletIdentity.findUnique({ where: { userId: dropId } }),
  ]);
  if ((keepWallet && dropWallet) || (keep.xId && drop.xId))
    throw new HttpError(409, 'Both accounts already have this identity.');
  if (dropWallet)
    await writes.walletIdentity.updateMany({ where: { userId: dropId }, data: { userId: keepId } });
  if (drop.xId) {
    const account = await tx.xAccount.findUnique({ where: { userId: dropId } });
    await writes.xAccount.deleteMany({ where: { userId: dropId } });
    await writes.user.update({ where: { id: dropId }, data: { xId: null } });
    await writes.user.update({
      where: { id: keepId },
      data: { xId: drop.xId, handle: drop.handle },
    });
    if (account) {
      await writes.xAccount.create({
        data: {
          userId: keepId,
          xUserId: account.xUserId,
          username: account.username,
          displayName: account.displayName,
          profileImage: account.profileImage,
          connectedAt: account.connectedAt,
        },
      });
    }
  }
  await writes.oAuthAttempt.deleteMany({ where: { userId: dropId } });
  await writes.session.deleteMany({ where: { userId: dropId } });
  try {
    await writes.user.delete({ where: { id: dropId } });
  } catch (error) {
    // A3: only this User-delete boundary translates FK rejection. No retry, no SQL detail.
    const source = error as { code?: string; meta?: { code?: string } };
    if (
      source?.code === 'P2003' ||
      source?.code === '23503' ||
      (source?.code === 'P2010' && source.meta?.code === '23503')
    )
      throw new HttpError(409, 'Only an activity-free account can be merged.');
    throw error;
  }
  await tx.moderationEvent.create({
    data: {
      actorId: keepId,
      action: 'account:merge',
      targetId: dropId,
      reason: 'self-service identity merge',
    },
  });
}
