import { db } from './db';
import { trackingEnabled } from './config';
import { scoreContributions, postPoints } from './tracking-domain';
import type { ResultPayload } from './tracking-review';
import { observedImpressions } from './raid-progress';
import { splitImpressionFunding } from './raid-allocation';
export async function trackingView(raidId: string, userId?: string) {
  const raid = await db.raid.findUnique({ where: { id: raidId }, include: { creator: true } });
  if (!raid || raid.trackingVersion !== 2 || raid.hidden || raid.creator.suspended) return null;
  const [posts, members, submissions, disputes, result, claims, allocations] = await Promise.all([
    db.post.findMany({ where: { raidId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    db.raidEnrollment.findMany({
      where: { raidId },
      include: { user: { select: { handle: true } } },
    }),
    userId
      ? db.postSubmission.findMany({
          where: { raidId, enrollment: { userId } },
          orderBy: { createdAt: 'desc' },
        })
      : [],
    userId
      ? db.raidDispute.findMany({
          where: { raidId, enrollment: { userId } },
          orderBy: { createdAt: 'desc' },
        })
      : [],
    raid.activeResultId
      ? db.campaignResult.findUnique({ where: { id: raid.activeResultId } })
      : null,
    db.feeClaim.findMany({
      where: { raidId },
      select: { grossLamports: true, costLamports: true },
    }),
    userId
      ? db.raidAllocation.findMany({
          where: {
            raidId,
            OR: [
              { raid: { creatorId: userId }, kind: 'REFUND' },
              {
                kind: 'REWARD',
                xId: {
                  in: (
                    await db.raidEnrollment.findMany({
                      where: { raidId, userId },
                      select: { xId: true },
                    })
                  ).map((member) => member.xId),
                },
              },
            ],
          },
        })
      : [],
  ]);
  const frozen = result?.payload as unknown as ResultPayload | undefined;
  const scored = scoreContributions(
    frozen
      ? frozen.contributions.map((p) => ({ ...p, text: '', createdAt: new Date(p.createdAt) }))
      : posts,
  );
  const scoredIds = new Set(scored.leaderboard.flatMap((a) => a.scoredPostIds));
  const member = members.find((m) => m.userId === userId);
  const net = claims.reduce((sum, c) => sum + c.grossLamports - c.costLamports, 0n);
  const estimatePool = net > 0n ? net - net / 10n : 0n;
  const observations = frozen?.contributions || posts;
  const impressions = observedImpressions(observations);
  const estimates =
    raid.studioVersion === 1 && raid.poolUnits && raid.impressionTarget && !impressions.missing
      ? splitImpressionFunding(
          raid.poolUnits,
          raid.impressionTarget,
          members.map((m) => ({
            xId: m.xId,
            walletAddress: m.walletAddress,
            views: observedImpressions(observations.filter((p) => p.enrollmentId === m.id)).total,
          })),
        )
      : null;
  const ownUsdcPayments = userId
    ? await db.usdcTransfer.findMany({
        where: {
          userId,
          allocationId: {
            in: (await db.usdcAllocation.findMany({ where: { raidId }, select: { id: true } })).map(
              (a) => a.id,
            ),
          },
        },
      })
    : [];
  const launchBudgets = raid.fundingAsset === 'LAUNCH' ? await db.launchCampaignBudget.findMany({where:{raidId}}) : [];
  const launchPayments = raid.fundingAsset === 'LAUNCH' && member ? await db.launchCampaignPayout.findMany({where:{raidId,xId:member.xId}}) : [];
  const launchEstimates = launchBudgets.map(b=>({asset:b.asset,allocation:raid.impressionTarget && !impressions.missing ? splitImpressionFunding(b.reservedUnits,raid.impressionTarget,
    members.map(m=>({xId:m.xId,walletAddress:m.walletAddress,views:observedImpressions(observations.filter(p=>p.enrollmentId===m.id)).total}))) : null}));
  const topPosts = observations
    .filter((p) => scoredIds.has(p.id))
    .sort((a, b) => postPoints(b) - postPoints(a) || a.id.localeCompare(b.id))
    .slice(0, 10)
    .map((p) => ({
      id: p.id,
      authorId: p.authorId,
      score: postPoints(p),
      likes: p.likes,
      replies: p.replies,
      reposts: p.reposts,
      quotes: p.quotes,
      views: p.views ?? null,
      observedAt: new Date(p.observedAt).toISOString(),
    }));
  return {
    impressions,
    tokenSymbol: raid.projectSymbol,
    launchBudgets: launchBudgets.map(b=>({asset:b.asset,reserved:b.reservedUnits.toString(),earned:b.earnedUnits.toString(),paid:b.paidUnits.toString(),network:b.network})),
    ownLaunchPayments: launchPayments.map(p=>({id:p.id,asset:p.asset,units:p.units.toString(),status:p.status,signature:p.signature,network:p.network})),
    currency: raid.fundingAsset,
    poolUnits: raid.poolUnits?.toString() || null,
    ownUsdcPayments: ownUsdcPayments.map((t) => ({
      id: t.id,
      amount: t.amount.toString(),
      status: t.status,
      signature: t.signature,
      network: t.network,
    })),
    impressionTarget: raid.impressionTarget,
    targetReachedAt: raid.targetReachedAt?.toISOString() || null,
    enabled: trackingEnabled(),
    holdReason: raid.holdReason,
    phase: raid.trackingPhase,
    ruleVersion: raid.ruleVersion,
    officialHandle: raid.officialHandle,
    health: !trackingEnabled()
      ? 'Tracking paused'
      : raid.collectionError
        ? 'X data temporarily unavailable'
        : raid.trackingPhase === 'FINALIZING'
          ? 'Finalizing'
          : raid.activeResultId
            ? 'Results collected'
            : !raid.observedAt ||
                Date.now() - +raid.observedAt > 600000 ||
                raid.coverage !== 'complete'
              ? 'Metrics delayed'
              : 'Tracking normally',
    resultVersion: result?.version || null,
    reviewEndsAt: raid.reviewEndsAt?.toISOString() || null,
    canSubmit:
      trackingEnabled() &&
      !!member &&
      ((raid.status === 'ACTIVE' && raid.endsAt > new Date()) ||
        (raid.trackingPhase === 'REVIEW' && !!raid.reviewEndsAt && raid.reviewEndsAt > new Date())),
    canJoin: trackingEnabled() && !member && raid.status === 'ACTIVE' && raid.endsAt > new Date(),
    enrollment: member
      ? {
          id: member.id,
          walletAddress: member.walletAddress,
          joinedAt: member.joinedAt.toISOString(),
        }
      : null,
    ownAllocations: allocations.map((allocation) => ({
      kind: allocation.kind,
      lamports: allocation.lamports,
      status: allocation.paidAt ? 'PAID' : 'PENDING',
      signature: allocation.signature,
    })),
    leaderboard: scored.leaderboard.map((a) => ({
      ...a,
      handle: members.find((m) => m.xId === a.xId)?.user.handle || a.xId,
      views: observedImpressions(observations.filter((p) => p.authorId === a.xId)).total,
      estimatedUsdc: estimates
        ? (estimates.rewards.find((r) => r.xId === a.xId)?.lamports || 0n).toString()
        : null,
      estimatedLaunch: launchEstimates.map(e=>({asset:e.asset,units:e.allocation?(e.allocation.rewards.find(r=>r.xId===a.xId)?.lamports || 0n).toString():null})),
      estimatedLamports: scored.score
        ? ((estimatePool * BigInt(a.score)) / BigInt(scored.score)).toString()
        : '0',
    })),
    topPosts,
    ownContributions: member
      ? posts
          .filter((p) => p.enrollmentId === member.id)
          .map((p) => ({
            id: p.id,
            qualification: p.qualification,
            reasonCode: p.reasonCode,
            availability: p.availability,
            reviewStatus: p.reviewStatus,
            observedAt: p.lastObservationId ? p.observedAt.toISOString() : null,
            scored: scoredIds.has(p.id),
            score: scoredIds.has(p.id) ? postPoints(p) : 0,
          }))
      : [],
    submissions: submissions.map((s) => ({
      id: s.id,
      postId: s.postId,
      status: s.status,
      reasonCode: s.reasonCode,
    })),
    disputes: disputes.map((d) => ({
      id: d.id,
      category: d.category,
      status: d.status,
      reason: d.reason,
      resolution: d.resolution,
    })),
  };
}
export type TrackingView = NonNullable<Awaited<ReturnType<typeof trackingView>>>;
