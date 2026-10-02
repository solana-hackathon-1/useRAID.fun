import { randomUUID } from 'node:crypto';
import { db } from './db';
import { lockTracking } from './tracking';
import { lockBalance, USDC_MINTS } from './usdc';
import { trackingBlockers, type ResultPayload } from './tracking-review';
import { splitImpressionFunding } from './raid-allocation';

export async function allocateUsdcRaid(raidId: string) {
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
      await lockBalance(tx, raid.creatorId);
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
      const amounts = payload.participants.map((p) => ({
        xId: p.xId,
        walletAddress: p.walletAddress,
        views: posts
          .filter((post) => post.enrollmentId === p.enrollmentId)
          .reduce((sum, post) => sum + (post.views || 0), 0),
      }));
      if (amounts.some((a) => !Number.isSafeInteger(a.views))) return;
      const shares = splitImpressionFunding(raid.poolUnits, raid.impressionTarget, amounts);
      const participants = new Map(payload.participants.map((p) => [p.xId, p]));
      const allocations = shares.rewards.map((reward) => ({
        id: randomUUID(),
        userId: participants.get(reward.xId)!.userId,
        xId: reward.xId,
        walletAddress: reward.walletAddress,
        amount: reward.lamports,
      }));
      await tx.usdcAllocation.createMany({
        data: allocations.map((a) => ({ ...a, raidId, resultId: result.id })),
      });
      await tx.usdcTransfer.createMany({
        data: allocations.map((a) => ({
          kind: 'REWARD',
          userId: a.userId,
          allocationId: a.id,
          amount: a.amount,
          walletAddress: a.walletAddress,
          recipient: raid.fundingRecipient!,
          network: raid.fundingNetwork,
          mint: raid.fundingNetwork === 'mainnet' ? USDC_MINTS.mainnet : USDC_MINTS.devnet,
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
