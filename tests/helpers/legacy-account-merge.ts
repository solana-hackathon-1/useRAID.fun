// Frozen production helper at70c654f; intentional old-binary compatibility fixture.
import type { Prisma } from '@prisma/client';

async function lockIdentity(tx: Prisma.TransactionClient, xId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`x-auth:${xId}`}, 0))`;
}
// Every table keyed to a user account; an account with none of these rows has nothing to lose.
async function isEmptyAccount(tx: Prisma.TransactionClient, userId: string) {
  const user = await tx.user.findUnique({ where: { id: userId } });
  if (!user || user.role === 'ADMIN' || user.suspended) return false;
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
export async function absorbLegacyAccount(
  tx: Prisma.TransactionClient,
  keepId: string,
  dropId: string,
) {
  if (keepId === dropId) throw new Error('Cannot merge an account into itself.');
  const [keep, drop] = await Promise.all([
    tx.user.findUniqueOrThrow({ where: { id: keepId } }),
    tx.user.findUniqueOrThrow({ where: { id: dropId } }),
  ]);
  if (!(await isEmptyAccount(tx, dropId)))
    throw new Error('Only an activity-free account can be merged.');
  const [keepWallet, dropWallet] = await Promise.all([
    tx.walletIdentity.findUnique({ where: { userId: keepId } }),
    tx.walletIdentity.findUnique({ where: { userId: dropId } }),
  ]);
  if ((keepWallet && dropWallet) || (keep.xId && drop.xId))
    throw new Error('Both accounts already have this identity.');
  if (drop.xId) await lockIdentity(tx, drop.xId);
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
