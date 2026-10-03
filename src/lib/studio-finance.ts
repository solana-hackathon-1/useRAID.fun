import { randomUUID } from 'node:crypto';
import { db } from './db';
import { lockTracking } from './tracking';
import { lockBalance, usdcLimits, studioSandbox, USDC_MINTS } from './usdc';
import { trackingSettlementEnabled } from './config';
import { trackingBlockers, type ResultPayload } from './tracking-review';
import { splitImpressionFunding } from './raid-allocation';

export async function allocateUsdcRaid(raidId: string) {
  if (!trackingSettlementEnabled() && !studioSandbox()) return;
  return db.$transaction(
    async (tx) => {
      await lockTracking(tx, raidId);
      const raid = await tx.raid.findUniqueOrThrow({
        where: { id: raidId },
        include: { creator: true },
      });
      if (
        raid.studioVersion !== 1 ||
        raid.fundingStatus !== 'VERIFIED' ||
        raid.trackingPhase !== 'APPROVED' ||
        !raid.poolUnits ||
        !raid.impressionTarget ||
        !raid.fundingRecipient ||
        !raid.activeResultId ||
        raid.hidden ||
        raid.creator.suspended
      )
        return;
      if (await trackingBlockers(tx, raidId)) return;
      if (await tx.balanceEntry.findUnique({ where: { key: `raid-settle:${raidId}` } })) return;
      const result = await tx.campaignResult.findUniqueOrThrow({
        where: { id: raid.activeResultId },
      });
      const payload = result.payload as unknown as ResultPayload;
      const posts = payload.contributions.filter(
        (p) =>
          p.qualification === 'QUALIFIED' &&
          p.availability === 'AVAILABLE' &&
          p.reviewStatus !== 'FLAGGED' &&
          !p.hidden &&
          !p.deleted,
      );
      if (posts.some((p) => p.views == null || !Number.isSafeInteger(p.views) || p.views < 0))
        return;
      const eligible = payload.participants.filter((p) => p.userId !== raid.creatorId);
      const amounts = eligible.map((p) => ({
        xId: p.xId,
        walletAddress: p.walletAddress,
        views: posts
          .filter((post) => post.enrollmentId === p.enrollmentId)
          .reduce((sum, post) => sum + (post.views || 0), 0),
      }));
      if (amounts.some((a) => !Number.isSafeInteger(a.views))) return;
      const shares = splitImpressionFunding(raid.poolUnits, raid.impressionTarget, amounts, {
        capBps: raid.authorCapBps,
        minPayout: usdcLimits().minReward,
      });
      const participants = new Map(eligible.map((p) => [p.xId, p]));
      const toAllocation = (reward: (typeof shares.rewards)[number], credit: boolean) => ({
        id: randomUUID(),
        userId: participants.get(reward.xId)!.userId,
        xId: reward.xId,
        walletAddress: reward.walletAddress,
        amount: reward.lamports,
        credit,
      });
      const allocations = [
        ...shares.rewards.map((r) => toAllocation(r, false)),
        ...shares.belowMinimum.map((r) => toAllocation(r, true)),
      ];
      // Lock order: tracking (above), then balances sorted by user id.
      for (const userId of [
        ...new Set([raid.creatorId, ...allocations.filter((a) => a.credit).map((a) => a.userId)]),
      ].sort())
        await lockBalance(tx, userId);
      const paidAt = new Date();
      await tx.usdcAllocation.createMany({
        data: allocations.map((a) => ({
          id: a.id,
          userId: a.userId,
          xId: a.xId,
          walletAddress: a.walletAddress,
          amount: a.amount,
          raidId,
          resultId: result.id,
        })),
      });
      const transfers = await tx.usdcTransfer.createManyAndReturn({
        data: allocations.map((a) => ({
          kind: a.credit ? 'REWARD_CREDIT' : 'REWARD',
          ...(a.credit ? { status: 'PAID', paidAt } : {}),
          userId: a.userId,
          allocationId: a.id,
          amount: a.amount,
          walletAddress: a.walletAddress,
          recipient: raid.fundingRecipient!,
          network: raid.fundingNetwork,
          mint: raid.fundingNetwork === 'mainnet' ? USDC_MINTS.mainnet : USDC_MINTS.devnet,
        })),
        select: { id: true, allocationId: true },
      });
      const transferIds = new Map(transfers.map((t) => [t.allocationId, t.id]));
      const credits = new Map<string, { amount: bigint; transferId: string }>();
      for (const a of allocations.filter((a) => a.credit)) {
        const held = credits.get(a.userId);
        credits.set(a.userId, {
          amount: (held?.amount || 0n) + a.amount,
          transferId: held?.transferId || transferIds.get(a.id)!,
        });
      }
      await tx.balanceEntry.createMany({
        data: [...credits].map(([userId, credit]) => ({
          key: `raid-reward-credit:${raidId}:${userId}`,
          userId,
          raidId,
          transferId: credit.transferId,
          network: raid.fundingNetwork,
          kind: 'RAID_REWARD_CREDIT',
          availableDelta: credit.amount,
          reservedDelta: 0n,
        })),
      });
      await tx.balanceEntry.create({
        data: {
          key: `raid-settle:${raidId}`,
          userId: raid.creatorId,
          raidId,
          network: raid.fundingNetwork,
          kind: 'RAID_SETTLED',
          availableDelta: shares.refund,
          reservedDelta: -raid.poolUnits,
        },
      });
      await tx.raid.update({ where: { id: raidId }, data: { trackingPhase: 'ALLOCATED' } });
    },
    { timeout: 30000 },
  );
}
