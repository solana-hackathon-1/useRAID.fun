import { db } from './db';
import { config } from './config';
export async function publicRewardView(mint: string, userId?: string) {
  if (config.demo) return null;
  const launch = await db.tokenLaunch.findUnique({
    where: { mint },
    select: {
      id: true,
      userId: true,
      feeAddress: true,
      status: true,
      error: true,
      raidId: true,
      signature: true,
      imageUri: true,
      raid: {
        select: {
          status: true,
          startsAt: true,
          endsAt: true,
          hidden: true,
          coverage: true,
          coveredUntil: true,
        },
      },
      rounds: { orderBy: { startsAt: 'desc' }, take: 20 },
      claims: { orderBy: { claimedAt: 'desc' }, take: 20 },
    },
  });
  if (!launch) return null;
  const raid = launch.raid;
  const dueAt = raid ? Math.min(Date.now() - 60000, +raid.endsAt) : 0;
  const dueEnd = raid
    ? +raid.endsAt <= dueAt
      ? +raid.endsAt
      : +raid.startsAt + Math.floor((dueAt - +raid.startsAt) / 3600000) * 3600000
    : 0;
  const xId = userId ? (await db.user.findUnique({ where: { id: userId } }))?.xId : null;
  const [enrollment, payouts, totals, personalTotals, paidHistory, settings] = await Promise.all([
    userId ? db.rewardEnrollment.findFirst({ where: { launchId: launch.id, userId } }) : null,
    xId
      ? db.rewardPayout.findMany({
          where: {
            launchId: launch.id,
            xId,
          },
          orderBy: { createdAt: 'desc' },
          take: 30,
        })
      : [],
    db.rewardPayout.groupBy({
      by: ['status'],
      where: { launchId: launch.id },
      _sum: { lamports: true },
    }),
    xId
      ? db.rewardPayout.groupBy({
          by: ['status'],
          where: { launchId: launch.id, xId },
          _sum: { lamports: true },
        })
      : [],
    db.rewardPayout.findMany({
      where: { launchId: launch.id, status: 'PAID', signature: { not: null } },
      orderBy: { paidAt: 'desc' },
      take: 20,
      select: { signature: true, lamports: true, walletAddress: true, paidAt: true },
    }),
    db.settings.findUnique({ where: { id: 'global' } }),
  ]);
  return {
    id: launch.id,
    mint,
    feeAddress: launch.feeAddress,
    status: launch.status,
    pausedReason: launch.error,
    globalPauseReason: !settings?.collectionEnabled
      ? 'Raid collection is paused.'
      : settings.payoutPaused
        ? 'Payouts are paused by operator.'
        : null,
    owner: userId === launch.userId,
    raidId: launch.raidId,
    signature: launch.signature,
    imageUri: launch.imageUri,
    activeRaid:
      launch.raid?.status === 'ACTIVE' && launch.raid.endsAt > new Date() && !launch.raid.hidden,
    settlementDelayed:
      !!raid &&
      dueEnd > +raid.startsAt &&
      (raid.coverage !== 'complete' || !raid.coveredUntil || +raid.coveredUntil < dueEnd),
    enrolled: !!enrollment,
    enrolledWallet: enrollment?.walletAddress || null,
    rounds: launch.rounds.map((r) => ({
      startsAt: r.startsAt.toISOString(),
      endsAt: r.endsAt.toISOString(),
      status: r.status,
      grossLamports: r.grossLamports.toString(),
      costLamports: r.costLamports.toString(),
      platformLamports: r.platformLamports.toString(),
      raiderLamports: r.raiderLamports.toString(),
    })),
    claims: launch.claims.map((c) => ({
      signature: c.signature,
      grossLamports: c.grossLamports.toString(),
      costLamports: c.costLamports.toString(),
      at: c.claimedAt.toISOString(),
    })),
    payouts: payouts.map((p) => ({
      lamports: p.lamports.toString(),
      status: p.status,
      signature: p.signature,
      at: p.createdAt.toISOString(),
    })),
    totals: Object.fromEntries(totals.map((t) => [t.status, t._sum.lamports?.toString() || '0'])),
    personalTotals: Object.fromEntries(
      personalTotals.map((t) => [t.status, t._sum.lamports?.toString() || '0']),
    ),
    paidHistory: paidHistory.map((p) => ({
      signature: p.signature,
      lamports: p.lamports.toString(),
      walletAddress: p.walletAddress,
      paidAt: p.paidAt?.toISOString() || null,
    })),
  };
}
