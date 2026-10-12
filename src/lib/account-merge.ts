import type { Prisma } from '@prisma/client';
import { hasHumanParticipant } from '../identity-storage';
import { createPrismaIdentityTransaction } from './identity-storage-adapter';

export async function lockIdentity(tx: Prisma.TransactionClient, xId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`x-auth:${xId}`}, 0))`;
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
export async function absorbAccount(tx: Prisma.TransactionClient, keepId: string, dropId: string) {
  if (keepId === dropId) throw new Error('Cannot merge an account into itself.');
  // One lock order for every identity writer (merge, X first-connect/reconnect/disconnect, link):
  //   1. the "x-auth:<xId>" advisory lock of the X identity involved, if any
  //   2. the dropped account's OAuthAttempt rows (locked here in stateHash order, deleted below)
  //   3. User rows, in stable id order
  //   4. XAccount / Session / wallet rows
  // completeConnection takes (1), deletes its claimed attempt (2) and only then updates a User
  // (3). A merge that locked Users first and deleted the attempts afterwards formed a cycle with
  // it (SQLSTATE 40P01): through the advisory key when the dropped account already had an X id,
  // and, for a first connection (xId = null, so there is no shared advisory key), through the
  // attempt row itself. The dropped account's X id can only be read before its row is locked, so
  // read it, take (1), clear (2), lock (3) and then confirm the id did not change; a connect that
  // won in the meantime makes the merge fail closed. Retrying a deadlock is not the mechanism.
  const observed = await tx.user.findUnique({ where: { id: dropId }, select: { xId: true } });
  if (observed?.xId) await lockIdentity(tx, observed.xId);
  await tx.$queryRaw`SELECT "stateHash" FROM "OAuthAttempt" WHERE "userId" = ${dropId} ORDER BY "stateHash" FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" IN (${keepId}, ${dropId}) ORDER BY "id" FOR NO KEY UPDATE`;
  const [keep, drop] = await Promise.all([
    tx.user.findUniqueOrThrow({ where: { id: keepId } }),
    tx.user.findUniqueOrThrow({ where: { id: dropId } }),
  ]);
  if (drop.xId !== (observed?.xId ?? null))
    throw new Error('Account identity changed during the merge; try again.');
  if (!(await isEmptyAccount(tx, dropId)))
    throw new Error('Only an activity-free account can be merged.');
  const [keepWallet, dropWallet] = await Promise.all([
    tx.walletIdentity.findUnique({ where: { userId: keepId } }),
    tx.walletIdentity.findUnique({ where: { userId: dropId } }),
  ]);
  if ((keepWallet && dropWallet) || (keep.xId && drop.xId))
    throw new Error('Both accounts already have this identity.');
  if (dropWallet)
    await tx.walletIdentity.updateMany({ where: { userId: dropId }, data: { userId: keepId } });
  if (drop.xId) {
    const account = await tx.xAccount.findUnique({ where: { userId: dropId } });
    await tx.xAccount.deleteMany({ where: { userId: dropId } });
    await tx.user.update({ where: { id: dropId }, data: { xId: null } });
    await tx.user.update({ where: { id: keepId }, data: { xId: drop.xId, handle: drop.handle } });
    if (account) {
      await tx.xAccount.create({
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
  await tx.user.update({
    where: { id: keepId },
    data: {
      approved: keep.approved || drop.approved,
      ...(keep.affiliation ? {} : { affiliation: drop.affiliation }),
    },
  });
  await tx.oAuthAttempt.deleteMany({ where: { userId: dropId } });
  await tx.session.deleteMany({ where: { userId: dropId } });
  await tx.user.delete({ where: { id: dropId } });
  await tx.moderationEvent.create({
    data: {
      actorId: keepId,
      action: 'account:merge',
      targetId: dropId,
      reason: 'self-service identity merge',
    },
  });
}
