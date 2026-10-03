import { db } from './db';
import { lockTracking } from './tracking';
export function observedImpressions(
  posts: {
    views?: number | null;
    qualification: string;
    availability: string;
    reviewStatus: string;
    hidden: boolean;
    deleted: boolean;
  }[],
) {
  const eligible = posts.filter(
    (p) =>
      p.qualification === 'QUALIFIED' &&
      p.availability === 'AVAILABLE' &&
      p.reviewStatus !== 'FLAGGED' &&
      !p.hidden &&
      !p.deleted,
  );
  const total = eligible.reduce((sum, p) => sum + BigInt(p.views ?? 0), 0n);
  return {
    total: Number(
      total > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : total,
    ),
    missing: eligible.filter((p) => p.views == null).length,
  };
}
export async function completeImpressionTarget(raidId: string) {
  await db.$transaction(async (tx) => {
    await lockTracking(tx, raidId);
    const raid = await tx.raid.findUniqueOrThrow({ where: { id: raidId } });
    if (
      (raid.mint && raid.studioVersion !== 1) ||
      raid.status !== 'ACTIVE' ||
      !raid.impressionTarget ||
      raid.fundingStatus !== 'VERIFIED' ||
      raid.coverage !== 'complete' ||
      raid.collectionError
    )
      return;
    const posts = await tx.post.findMany({ where: { raidId } });
    if (observedImpressions(posts).total < raid.impressionTarget) return;
    const now = new Date();
    await tx.raid.update({
      where: { id: raidId },
      data: {
        status: 'ENDED',
        targetReachedAt: now,
        endsAt: now,
        trackingPhase: 'FINALIZING',
        sinceId: null,
        nextToken: null,
        searchEndAt: null,
        searchQuery: null,
        pendingNewestId: null,
        finalRefreshed: false,
      },
    });
  });
}
