import type { Prisma } from '@prisma/client';
import { db } from './db';

export const OPS_BLOCKERS = 50;
export const OPS_HISTORY = 25;
const OPERATOR_PHASES = ['FINALIZING', 'REVIEW', 'APPROVED', 'HELD'];
const LOOKUP_REASONS = ['LOOKUP_FAILED', 'POST_RESTRICTED'];
const v2 = { raid: { trackingVersion: 2 } } satisfies Prisma.PostWhereInput;

// Posts that stop finalization or need an operator decision, mirroring trackingBlockers.
export const blockerWhere = {
  ...v2,
  adminExcluded: false,
  OR: [
    { reviewStatus: 'FLAGGED' },
    { qualification: 'DATA_INCOMPLETE' },
    { availability: 'DATA_INCOMPLETE' },
    { reasonCode: { in: LOOKUP_REASONS } },
  ],
} satisfies Prisma.PostWhereInput;
// Everything that was excluded or went unavailable and is not already a blocker.
export const historyWhere = {
  ...v2,
  reviewStatus: { not: 'FLAGGED' },
  AND: [
    { OR: [{ qualification: 'EXCLUDED' }, { availability: { not: 'AVAILABLE' } }] },
    {
      OR: [
        { adminExcluded: true },
        {
          qualification: { not: 'DATA_INCOMPLETE' },
          availability: { not: 'DATA_INCOMPLETE' },
          OR: [{ reasonCode: null }, { reasonCode: { notIn: LOOKUP_REASONS } }],
        },
      ],
    },
  ],
} satisfies Prisma.PostWhereInput;
const raidWhere = {
  trackingVersion: 2,
  OR: [
    { trackingPhase: { in: OPERATOR_PHASES } },
    { collectionError: { not: null }, trackingPhase: { notIn: ['ALLOCATED', 'HELD_RESOLVED'] } },
  ],
} satisfies Prisma.RaidWhereInput;

export async function loadTrackingOps(now = new Date()) {
  const [
    raids,
    raidCount,
    needsReview,
    needsReviewCount,
    history,
    historyCount,
    disputes,
    disputeCount,
    endpoints,
    stale,
    backlog,
  ] = await Promise.all([
    db.raid.findMany({
      where: raidWhere,
      orderBy: [{ reviewEndsAt: 'asc' }, { createdAt: 'asc' }],
      take: 50,
    }),
    db.raid.count({ where: raidWhere }),
    db.post.findMany({ where: blockerWhere, orderBy: { createdAt: 'asc' }, take: OPS_BLOCKERS }),
    db.post.count({ where: blockerWhere }),
    db.post.findMany({ where: historyWhere, orderBy: { observedAt: 'desc' }, take: OPS_HISTORY }),
    db.post.count({ where: historyWhere }),
    db.raidDispute.findMany({ where: { status: 'OPEN' }, orderBy: { createdAt: 'asc' }, take: 50 }),
    db.raidDispute.count({ where: { status: 'OPEN' } }),
    db.xEndpointState.findMany(),
    db.post.count({
      where: {
        raid: { trackingVersion: 2, status: 'ACTIVE' },
        observedAt: { lt: new Date(+now - 600000) },
      },
    }),
    db.job.count({ where: { doneAt: null } }),
  ]);
  const heldLaunchIds = [
    ...new Set(
      raids.flatMap((r) =>
        r.trackingPhase === 'HELD' && r.tokenLaunchId ? [r.tokenLaunchId] : [],
      ),
    ),
  ];
  // Carry targets come from their own query so the capped operator list cannot hide them.
  const [held, carryTargets] = await Promise.all([
    db.feeClaim.groupBy({
      by: ['raidId'],
      where: {
        roundId: null,
        raidId: { in: raids.filter((r) => r.trackingPhase === 'HELD').map((r) => r.id) },
      },
      _sum: { grossLamports: true, costLamports: true },
    }),
    heldLaunchIds.length
      ? db.raid.findMany({
          where: { tokenLaunchId: { in: heldLaunchIds }, status: 'ACTIVE' },
          orderBy: { createdAt: 'asc' },
        })
      : [],
  ]);
  return {
    raids,
    raidCount,
    held,
    carryTargets,
    needsReview,
    needsReviewCount,
    history,
    historyCount,
    disputes,
    disputeCount,
    endpoints,
    stale,
    backlog,
  };
}
