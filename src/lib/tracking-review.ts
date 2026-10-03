import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { db } from './db';
import { HttpError } from './auth-primitives';
import { trackingEnabled } from './config';
import { isLockedPhase, scoreContributions } from './tracking-domain';
import { observedImpressions } from './raid-progress';
import { assertTrackingEnabled, lockTracking, requalifyDuplicates } from './tracking';

export const REVIEW_MS = 2 * 3600000;
export const MAX_REVIEW_MS = 24 * 3600000;
export interface ResultPayload {
  ruleVersion: number;
  scoringVersion: number;
  endsAt: string;
  participants: {
    enrollmentId: string;
    userId: string;
    xId: string;
    walletAddress: string;
    joinedAt: string;
    score: number;
    scoredPostIds: string[];
  }[];
  contributions: {
    id: string;
    authorId: string;
    enrollmentId: string | null;
    createdAt: string;
    observationId: string | null;
    observedAt: string;
    likes: number;
    replies: number;
    reposts: number;
    quotes: number;
    views?: number | null;
    targetPostId?: string | null;
    qualification: string;
    reasonCode: string | null;
    availability: string;
    reviewStatus: string;
    hidden: boolean;
    deleted: boolean;
  }[];
}
export async function trackingBlockers(tx: Prisma.TransactionClient, raidId: string) {
  const [jobs, submissions, disputed, posts] = await Promise.all([
    tx.job.count({
      where: {
        doneAt: null,
        failedAt: null,
        kind: { in: ['collect', 'refresh', 'submission', 'tracking-correction'] },
        payload: { path: ['raidId'], equals: raidId },
      },
    }),
    tx.postSubmission.count({ where: { raidId, status: { in: ['QUEUED', 'DATA_INCOMPLETE'] } } }),
    tx.raidDispute.count({ where: { raidId, status: 'OPEN' } }),
    tx.post.count({
      where: {
        raidId,
        adminExcluded: false,
        OR: [
          { reviewStatus: 'FLAGGED' },
          { qualification: 'DATA_INCOMPLETE' },
          { availability: 'DATA_INCOMPLETE' },
        ],
      },
    }),
  ]);
  return jobs + submissions + disputed + posts;
}
export function measureEnd(
  raid: { endsAt: Date; measureUntil: Date | null; impressionTarget: number | null },
  impressions: number,
) {
  if (!raid.measureUntil || raid.measureUntil <= raid.endsAt) return raid.endsAt;
  if (raid.impressionTarget && impressions >= raid.impressionTarget) return raid.endsAt;
  return raid.measureUntil;
}
export async function finalizeTracking(raidId: string, now = new Date()) {
  if (!trackingEnabled()) return;
  return db.$transaction(
    async (tx) => {
      await lockTracking(tx, raidId);
      const raid = await tx.raid.findUniqueOrThrow({
        where: { id: raidId },
        include: { creator: true },
      });
      if (
        raid.trackingVersion !== 2 ||
        raid.endsAt > now ||
        raid.hidden ||
        raid.creator.suspended ||
        isLockedPhase(raid.trackingPhase)
      )
        return;
      if (
        !raid.finalRefreshed ||
        raid.coverage !== 'complete' ||
        !raid.coveredUntil ||
        raid.coveredUntil < raid.endsAt ||
        raid.nextToken ||
        raid.searchEndAt ||
        raid.collectionError
      )
        return;
      if (await trackingBlockers(tx, raidId)) return;
      const posts = await tx.post.findMany({ where: { raidId }, orderBy: { id: 'asc' } });
      // An early end keeps measuring already-qualified posts until the originally scheduled end.
      const until = measureEnd(raid, observedImpressions(posts).total);
      if (until > now) return;
      if (
        posts.some(
          (p) => p.qualification === 'QUALIFIED' && (!p.lastObservationId || p.observedAt < until),
        )
      )
        return;
      const members = await tx.raidEnrollment.findMany({
        where: { raidId },
        orderBy: { xId: 'asc' },
      });
      const scores = scoreContributions(posts);
      const payload: ResultPayload = {
        ruleVersion: raid.ruleVersion,
        scoringVersion: raid.scoringVersion,
        endsAt: raid.endsAt.toISOString(),
        participants: members.map((m) => {
          const score = scores.leaderboard.find((a) => a.xId === m.xId);
          return {
            enrollmentId: m.id,
            userId: m.userId,
            xId: m.xId,
            walletAddress: m.walletAddress,
            joinedAt: m.joinedAt.toISOString(),
            score: score?.score || 0,
            scoredPostIds: score?.scoredPostIds || [],
          };
        }),
        contributions: posts.map((p) => ({
          id: p.id,
          authorId: p.authorId,
          enrollmentId: p.enrollmentId,
          createdAt: p.createdAt.toISOString(),
          observationId: p.lastObservationId,
          observedAt: p.observedAt.toISOString(),
          likes: p.likes,
          replies: p.replies,
          reposts: p.reposts,
          quotes: p.quotes,
          views: p.views,
          targetPostId: p.targetPostId,
          qualification: p.qualification,
          reasonCode: p.reasonCode,
          availability: p.availability,
          reviewStatus: p.reviewStatus,
          hidden: p.hidden,
          deleted: p.deleted,
        })),
      };
      const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      const previous = raid.activeResultId
        ? await tx.campaignResult.findUnique({ where: { id: raid.activeResultId } })
        : null;
      if (!previous || previous.fingerprint !== fingerprint) {
        const result = await tx.campaignResult.create({
          data: {
            raidId,
            version: (previous?.version || 0) + 1,
            fingerprint,
            payload: payload as unknown as Prisma.InputJsonValue,
            createdAt: now,
          },
        });
        const first = previous
          ? await tx.campaignResult.findFirst({
              where: { raidId },
              orderBy: { version: 'asc' },
              select: { createdAt: true },
            })
          : null;
        await tx.raid.update({
          where: { id: raidId },
          data: {
            activeResultId: result.id,
            trackingPhase: 'REVIEW',
            reviewEndsAt: new Date(
              Math.min(+now + REVIEW_MS, first ? +first.createdAt + MAX_REVIEW_MS : Infinity),
            ),
          },
        });
        return result;
      }
      await tx.raid.update({
        where: { id: raidId },
        data: {
          trackingPhase:
            raid.reviewEndsAt && raid.reviewEndsAt <= now
              ? !raid.tokenLaunchId || scores.score
                ? 'APPROVED'
                : 'HELD'
              : 'REVIEW',
          holdReason:
            raid.reviewEndsAt && raid.reviewEndsAt <= now && !scores.score
              ? 'NO_ELIGIBLE_SCORES'
              : null,
        },
      });
      return previous;
    },
    { timeout: 30000 },
  );
}
export async function openDispute(
  raidId: string,
  userId: string,
  input: { category: string; reason: string; postId?: string },
) {
  assertTrackingEnabled();
  if (
    !['MISSING_POST', 'EXCLUSION', 'METRICS', 'IDENTITY'].includes(input.category) ||
    !input.reason?.trim() ||
    input.reason.length > 2000
  )
    throw new HttpError(
      400,
      'Choose a dispute category and provide a reason (up to 2000 characters).',
    );
  return db.$transaction(async (tx) => {
    await lockTracking(tx, raidId);
    const raid = await tx.raid.findUniqueOrThrow({ where: { id: raidId } });
    if (
      raid.trackingPhase !== 'REVIEW' ||
      !raid.activeResultId ||
      !raid.reviewEndsAt ||
      raid.reviewEndsAt <= new Date()
    )
      throw new HttpError(409, 'Review window is closed.');
    const member = await tx.raidEnrollment.findUnique({
      where: { raidId_userId: { raidId, userId } },
    });
    if (!member) throw new HttpError(403, 'Only enrolled participants may dispute this Raid.');
    if (input.postId) {
      const post = await tx.post.findUnique({ where: { id: input.postId } });
      if (post && (post.raidId !== raidId || post.authorId !== member.xId))
        throw new HttpError(403, 'This contribution is not yours.');
    }
    return tx.raidDispute.create({
      data: {
        raidId,
        enrollmentId: member.id,
        resultId: raid.activeResultId,
        postId: input.postId || null,
        category: input.category,
        reason: input.reason.trim(),
      },
    });
  });
}
export async function resolveTracking(
  raidId: string,
  actorId: string,
  input: {
    action:
      | 'clear'
      | 'exclude'
      | 'restore'
      | 'refresh'
      | 'reject-dispute'
      | 'resolve-dispute'
      | 'import-post'
      | 'accept-coverage';
    postId?: string;
    disputeId?: string;
    reason: string;
  },
) {
  assertTrackingEnabled();
  if (!input.reason?.trim() || input.reason.length > 2000)
    throw new HttpError(400, 'An audit reason is required (up to 2000 characters).');
  return db.$transaction(
    async (tx) => {
      await lockTracking(tx, raidId);
      const actor = await tx.user.findUnique({ where: { id: actorId } });
      if (actor?.role !== 'ADMIN' || actor.suspended)
        throw new HttpError(403, 'Administrator access required.');
      const raid = await tx.raid.findUniqueOrThrow({ where: { id: raidId } });
      if (raid.trackingVersion !== 2 || isLockedPhase(raid.trackingPhase))
        throw new HttpError(409, 'Results are locked.');
      let changed = false;
      if (input.action === 'reject-dispute' || input.action === 'resolve-dispute') {
        const dispute = input.disputeId
          ? await tx.raidDispute.findUnique({ where: { id: input.disputeId } })
          : null;
        if (!dispute || dispute.raidId !== raidId || dispute.status !== 'OPEN')
          throw new HttpError(409, 'Open dispute not found.');
        await tx.raidDispute.update({
          where: { id: dispute.id },
          data: {
            status: input.action === 'reject-dispute' ? 'REJECTED' : 'RESOLVED',
            resolution: input.reason,
            actorId,
            resolvedAt: new Date(),
          },
        });
      } else if (input.action === 'accept-coverage') {
        if (
          raid.holdReason !== 'COVERAGE_EXPIRED' ||
          raid.status !== 'ENDED' ||
          raid.finalRefreshed
        )
          throw new HttpError(409, 'This Raid is not waiting on a coverage decision.');
        await tx.raid.update({
          where: { id: raidId },
          data: {
            holdReason: null,
            collectionError: null,
            nextToken: null,
            searchEndAt: null,
            searchQuery: null,
            pendingNewestId: null,
            trackingPhase: 'FINALIZING',
          },
        });
        await tx.job.create({
          data: {
            key: `accept-coverage:${raidId}:${crypto.randomUUID()}`,
            kind: 'refresh',
            priority: 30,
            payload: { raidId, after: '', final: true, coveredUntil: raid.endsAt.toISOString() },
          },
        });
      } else if (input.action === 'import-post') {
        const dispute = input.disputeId
          ? await tx.raidDispute.findUnique({ where: { id: input.disputeId } })
          : null;
        if (!dispute || dispute.raidId !== raidId || dispute.status !== 'OPEN' || !dispute.postId)
          throw new HttpError(409, 'Open missing-post dispute with post ID required.');
        const submission = await tx.postSubmission.upsert({
          where: {
            raidId_enrollmentId_postId: {
              raidId,
              enrollmentId: dispute.enrollmentId,
              postId: dispute.postId,
            },
          },
          create: { raidId, enrollmentId: dispute.enrollmentId, postId: dispute.postId },
          update: { status: 'QUEUED', reasonCode: null },
        });
        await tx.job.create({
          data: {
            key: `dispute-import:${dispute.id}:${crypto.randomUUID()}`,
            kind: 'submission',
            priority: 30,
            payload: { raidId, postId: dispute.postId, submissionId: submission.id },
          },
        });
      } else {
        const post = input.postId
          ? await tx.post.findUnique({ where: { id: input.postId } })
          : null;
        if (!post || post.raidId !== raidId) throw new HttpError(404, 'Contribution not found.');
        if (input.action === 'clear')
          await tx.post.update({ where: { id: post.id }, data: { reviewStatus: 'CLEARED' } });
        else if (input.action === 'exclude')
          await tx.post.update({
            where: { id: post.id },
            data: {
              adminExcluded: true,
              qualification: 'EXCLUDED',
              reasonCode: 'ADMIN_EXCLUDED',
              reviewStatus: 'CLEARED',
            },
          });
        else if (input.action === 'refresh' || input.action === 'restore') {
          if (input.action === 'restore')
            await tx.post.update({
              where: { id: post.id },
              data: { adminExcluded: false, hidden: false },
            });
          await tx.job.create({
            data: {
              key: `correction:${post.id}:${crypto.randomUUID()}`,
              kind: 'tracking-correction',
              priority: 30,
              payload: { raidId, postId: post.id },
            },
          });
        } else throw new HttpError(400, 'Unsupported correction.');
        const updated = await tx.post.findUniqueOrThrow({ where: { id: post.id } });
        await tx.contributionDecision.create({
          data: {
            postId: post.id,
            actorId,
            qualification: updated.qualification,
            reasonCode: updated.reasonCode,
            ruleVersion: post.ruleVersion,
            evidence: {
              action: input.action,
              reason: input.reason,
              observationId: post.lastObservationId,
            },
          },
        });
        await requalifyDuplicates(tx, raidId);
        changed = true;
      }
      await tx.moderationEvent.create({
        data: {
          actorId,
          action: `tracking:${input.action}`,
          targetId: input.postId || input.disputeId || raidId,
          reason: input.reason,
        },
      });
      if (changed && raid.activeResultId)
        await tx.raid.update({ where: { id: raidId }, data: { trackingPhase: 'FINALIZING' } });
    },
    { timeout: 30000 },
  );
}

// An explicit operator decision may carry held claims to a later Raid of the same token.
// This changes ledger attribution only; it cannot send SOL or edit an old result.
export async function carryHeldFunds(
  raidId: string,
  targetRaidId: string,
  actorId: string,
  reason: string,
) {
  assertTrackingEnabled();
  if (!reason.trim() || reason.length > 2000 || raidId === targetRaidId)
    throw new HttpError(400, 'A different target Raid and audit reason are required.');
  return db.$transaction(async (tx) => {
    for (const id of [raidId, targetRaidId].sort()) await lockTracking(tx, id);
    const actor = await tx.user.findUnique({ where: { id: actorId } });
    if (actor?.role !== 'ADMIN' || actor.suspended)
      throw new HttpError(403, 'Administrator access required.');
    const source = await tx.raid.findUniqueOrThrow({ where: { id: raidId } });
    const target = await tx.raid.findUniqueOrThrow({ where: { id: targetRaidId } });
    if (
      source.trackingPhase !== 'HELD' ||
      !source.finalFeeSweepAt ||
      !source.tokenLaunchId ||
      target.tokenLaunchId !== source.tokenLaunchId ||
      target.trackingVersion !== 2 ||
      target.startsAt <= source.startsAt ||
      target.status !== 'ACTIVE' ||
      target.endsAt <= new Date() ||
      target.activeResultId ||
      target.hidden
    )
      throw new HttpError(
        409,
        'Choose an active later Raid of the same token; source fees must be fully collected and held.',
      );
    const claims = await tx.feeClaim.findMany({ where: { raidId, roundId: null } });
    await tx.feeClaim.updateMany({
      where: { id: { in: claims.map((c) => c.id) }, roundId: null },
      data: { raidId: targetRaidId },
    });
    await tx.raid.update({ where: { id: raidId }, data: { trackingPhase: 'HELD_RESOLVED' } });
    await tx.moderationEvent.create({
      data: {
        actorId,
        action: 'tracking:carry-held',
        targetId: raidId,
        reason: `${reason}\nTarget: ${targetRaidId}; claims: ${claims.map((c) => c.id).join(',')}; gross lamports: ${claims.reduce((sum, c) => sum + c.grossLamports, 0n)}`,
      },
    });
  });
}
