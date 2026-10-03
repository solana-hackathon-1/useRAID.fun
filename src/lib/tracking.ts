import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { db } from './db';
import { HttpError } from './auth-primitives';
import { trackingEnabled } from './config';
import { normalize, type XPost } from './domain';
import {
  automaticRaidId,
  qualificationReason,
  duplicatePeers,
  validMetrics,
} from './tracking-domain';
import { matchedTarget } from './studio-attribution';

export async function lockTracking(tx: Prisma.TransactionClient, raidId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`tracking:${raidId}`}, 0))`;
}
export function assertTrackingEnabled() {
  if (!trackingEnabled()) throw new HttpError(503, 'X tracking is paused.');
}
export async function enrollRaid(raidId: string, userId: string) {
  assertTrackingEnabled();
  return db.$transaction(async (tx) => {
    await lockTracking(tx, raidId);
    const raid = await tx.raid.findUnique({ where: { id: raidId }, include: { creator: true } });
    if (
      !raid ||
      raid.trackingVersion !== 2 ||
      raid.hidden ||
      raid.creator.suspended ||
      raid.status !== 'ACTIVE' ||
      raid.endsAt <= new Date()
    )
      throw new HttpError(409, 'No active tracking Raid.');
    if (raid.creatorId === userId) throw new HttpError(403, 'Creators cannot join their own Raid.');
    const [wallet, account, user] = await Promise.all([
      tx.walletIdentity.findUnique({ where: { userId } }),
      tx.xAccount.findUnique({ where: { userId } }),
      tx.user.findUnique({ where: { id: userId } }),
    ]);
    if (!wallet || !account || !user || user.suspended)
      throw new HttpError(403, 'Verify both wallet and X account before joining.');
    const existing = await tx.raidEnrollment.findFirst({
      where: {
        raidId,
        OR: [{ userId }, { xId: account.xUserId }, { walletAddress: wallet.address }],
      },
    });
    if (existing) {
      if (
        existing.userId !== userId ||
        existing.xId !== account.xUserId ||
        existing.walletAddress !== wallet.address
      )
        throw new HttpError(409, 'Raid reward identity is already locked.');
      return existing;
    }
    return tx.raidEnrollment.create({
      data: { raidId, userId, xId: account.xUserId, walletAddress: wallet.address },
    });
  });
}
export async function submitTrackingPost(raidId: string, userId: string, postId: string) {
  assertTrackingEnabled();
  return db.$transaction(async (tx) => {
    await lockTracking(tx, raidId);
    const raid = await tx.raid.findUnique({ where: { id: raidId }, include: { creator: true } });
    if (!raid || raid.trackingVersion !== 2 || raid.hidden || raid.creator.suspended)
      throw new HttpError(404, 'Raid not found.');
    const enrollment = await tx.raidEnrollment.findUnique({
      where: { raidId_userId: { raidId, userId } },
    });
    if (!enrollment) throw new HttpError(403, 'Join this Raid before submitting posts.');
    const existing = await tx.postSubmission.findUnique({
      where: { raidId_enrollmentId_postId: { raidId, enrollmentId: enrollment.id, postId } },
    });
    if (existing) return existing;
    const now = new Date();
    if (
      !(raid.status === 'ACTIVE' && raid.endsAt > now) &&
      !(raid.trackingPhase === 'REVIEW' && raid.reviewEndsAt && raid.reviewEndsAt > now)
    )
      throw new HttpError(409, 'This Raid is not accepting submissions.');
    const post = await tx.post.findUnique({ where: { id: postId } });
    if (post && post.raidId !== raidId)
      throw new HttpError(409, 'Post already belongs to another Raid.');
    const submission = await tx.postSubmission.create({
      data: { raidId, enrollmentId: enrollment.id, postId },
    });
    await tx.job.create({
      data: {
        key: `submission:${submission.id}`,
        kind: 'submission',
        payload: { raidId, postId, submissionId: submission.id },
        priority: 20,
      },
    });
    return submission;
  });
}

// Decisions store IDs/reasons, not source text, so retention can redact content independently.
export async function requalifyDuplicates(tx: Prisma.TransactionClient, raidId: string) {
  const posts = await tx.post.findMany({
    where: {
      raidId,
      enrollmentId: { not: null },
      availability: 'AVAILABLE',
      adminExcluded: false,
      hidden: false,
      OR: [{ qualification: 'QUALIFIED' }, { reasonCode: 'DUPLICATE_CONTENT' }],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const first = new Map<string, string>();
  const peerIds = duplicatePeers(posts);
  for (const p of posts) {
    const text = normalize(p.text),
      key = `${p.authorId}:${p.contentHash || text}`;
    const duplicate = p.contentHash || text ? first.get(key) : undefined;
    if ((p.contentHash || text) && !duplicate) first.set(key, p.id);
    const qualification = duplicate ? 'EXCLUDED' : 'QUALIFIED';
    const reasonCode = duplicate ? 'DUPLICATE_CONTENT' : null;
    const peers = !duplicate ? peerIds.get(p.id)! : [];
    const fingerprint = peers.length
      ? createHash('sha256')
          .update([p.id, ...peers].sort().join(':'))
          .digest('hex')
      : null;
    const reviewStatus = fingerprint
      ? p.reviewFingerprint === fingerprint && p.reviewStatus === 'CLEARED'
        ? 'CLEARED'
        : 'FLAGGED'
      : 'CLEAR';
    if (
      p.qualification !== qualification ||
      p.reasonCode !== reasonCode ||
      p.reviewStatus !== reviewStatus
    ) {
      await tx.post.update({
        where: { id: p.id },
        data: { qualification, reasonCode, reviewStatus, reviewFingerprint: fingerprint },
      });
      await tx.contributionDecision.create({
        data: {
          postId: p.id,
          qualification,
          reasonCode,
          ruleVersion: p.ruleVersion,
          evidence: {
            duplicateOf: duplicate || null,
            relatedPosts: peers,
            reviewStatus,
          },
        },
      });
    }
  }
}

export async function ingestTracking(
  raidId: string,
  posts: XPost[],
  options: {
    sampleKey?: string;
    source?: string;
    submissionId?: string;
    correction?: boolean;
  } = {},
) {
  assertTrackingEnabled();
  const sampleKey = options.sampleKey || randomUUID();
  return db.$transaction(
    async (tx) => {
      await lockTracking(tx, raidId);
      const raid = await tx.raid.findUniqueOrThrow({
        where: { id: raidId },
        include: { briefPosts: true },
      });
      if (['APPROVED', 'ALLOCATED', 'HELD', 'HELD_RESOLVED'].includes(raid.trackingPhase)) return;
      if (raid.activeResultId && !options.submissionId && !options.correction) return;
      const tags = new Set(
        (await tx.raid.findMany({ select: { tag: true } })).map((r) => r.tag.toLowerCase()),
      );
      const submission = options.submissionId
        ? await tx.postSubmission.findUniqueOrThrow({
            where: { id: options.submissionId },
            include: { enrollment: true },
          })
        : null;
      if (submission && submission.raidId !== raidId) throw new Error('Submission Raid mismatch');
      const postTimes = posts.map((post) => Date.parse(post.created_at)).filter(Number.isFinite);
      const earliestPost = postTimes.length ? new Date(Math.min(...postTimes)) : null;
      const latestPost = postTimes.length ? new Date(Math.max(...postTimes)) : null;
      const matchingEnrollments =
        raid.ruleVersion >= 3 && !submission
          ? await tx.raidEnrollment.findMany({
              where: {
                xId: { in: posts.map((post) => post.author_id) },
                ...(latestPost ? { joinedAt: { lte: latestPost } } : {}),
                raid: {
                  trackingVersion: 2,
                  status: { in: ['ACTIVE', 'ENDED'] },
                  hidden: false,
                  creator: { suspended: false },
                  ...(latestPost ? { startsAt: { lte: latestPost } } : {}),
                  ...(earliestPost ? { endsAt: { gt: earliestPost } } : {}),
                },
              },
              include: { raid: { include: { briefPosts: true } } },
            })
          : [];
      const owned = new Set(
        (
          await tx.post.findMany({
            where: { raidId, id: { in: posts.map((p) => p.id).filter(Boolean) } },
            select: { id: true },
          })
        ).map((p) => p.id),
      );
      for (const p of [...posts].sort((a, b) => a.id.localeCompare(b.id))) {
        if (!p.id || !p.author_id || !Number.isFinite(Date.parse(p.created_at)))
          throw new Error('X returned incomplete post identity.');
        if (
          raid.ruleVersion >= 3 &&
          !submission &&
          !owned.has(p.id) &&
          automaticRaidId(
            p,
            matchingEnrollments
              .filter((enrollment) => enrollment.xId === p.author_id)
              .map((enrollment) => ({ raid: enrollment.raid, enrollment })),
            tags,
          ) !== raidId
        )
          continue;
        if (
          submission &&
          (p.id !== submission.postId || p.author_id !== submission.enrollment.xId)
        ) {
          await tx.postSubmission.update({
            where: { id: submission.id },
            data: { status: 'EXCLUDED', reasonCode: 'AUTHOR_MISMATCH' },
          });
          continue;
        }
        // Global post lock prevents concurrent cross-Raid imports from acquiring the same ID.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`post:${p.id}`}, 0))`;
        const old = await tx.post.findUnique({ where: { id: p.id } });
        if (old && old.raidId !== raidId) {
          if (submission)
            await tx.postSubmission.update({
              where: { id: submission.id },
              data: { status: 'EXCLUDED', reasonCode: 'OTHER_RAID' },
            });
          continue;
        }
        // Repeated URL submissions must not refresh frozen results.
        if (old && raid.activeResultId && !options.correction) {
          if (submission)
            await tx.postSubmission.update({
              where: { id: submission.id },
              data: { status: old.qualification, reasonCode: old.reasonCode },
            });
          continue;
        }
        const priorSample =
          old &&
          (await tx.metricObservation.findUnique({
            where: { postId_sampleKey: { postId: p.id, sampleKey } },
          }));
        if (priorSample) continue;
        const enrollment = await tx.raidEnrollment.findUnique({
          where: { raidId_xId: { raidId, xId: p.author_id } },
        });
        let reasonCode = qualificationReason(p, raid, enrollment, tags);
        if (old?.adminExcluded) reasonCode = 'ADMIN_EXCLUDED';
        const valid = validMetrics(p),
          m = p.public_metrics;
        const qualification = reasonCode ? 'EXCLUDED' : valid ? 'QUALIFIED' : 'DATA_INCOMPLETE';
        if (!valid && !reasonCode) reasonCode = 'METRICS_INCOMPLETE';
        // An unrelated or ineligible post must not enter a frozen payload or reopen review.
        if (raid.activeResultId && !options.correction && !old && qualification === 'EXCLUDED') {
          if (submission)
            await tx.postSubmission.update({
              where: { id: submission.id },
              data: { status: qualification, reasonCode },
            });
          continue;
        }
        const now = new Date();
        const data = {
          targetPostId: raid.ruleVersion >= 4 ? matchedTarget(p, raid.briefPosts) : null,
          authorId: p.author_id,
          text: p.text,
          normalized: normalize(p.text),
          contentHash: createHash('sha256').update(normalize(p.text)).digest('hex'),
          createdAt: new Date(p.created_at),
          enrollmentId: enrollment?.id || null,
          postType: p.referenced_tweets?.some((t) => t.type === 'replied_to')
            ? 'REPLY'
            : p.referenced_tweets?.some((t) => t.type === 'retweeted')
              ? 'REPOST'
              : p.referenced_tweets?.some((t) => t.type === 'quoted')
                ? 'QUOTE'
                : 'ORIGINAL',
          qualification,
          reasonCode,
          ruleVersion: raid.ruleVersion,
          availability: valid ? 'AVAILABLE' : 'DATA_INCOMPLETE',
          deleted: false,
          contentExpiredAt: null,
          ...(valid && m
            ? {
                likes: m.like_count,
                replies: m.reply_count,
                reposts: m.retweet_count,
                quotes: m.quote_count,
                views:
                  Number.isSafeInteger(m.impression_count) &&
                  m.impression_count! >= 0 &&
                  m.impression_count! <= 2147483647
                    ? m.impression_count!
                    : null,
                observedAt: now,
              }
            : {}),
        };
        await tx.post.upsert({
          where: { id: p.id },
          create: {
            id: p.id,
            raidId,
            observedAt: now,
            source: options.source || 'SEARCH',
            ...data,
          },
          update: data,
        });
        if (valid && m) {
          const observation = await tx.metricObservation.create({
            data: {
              postId: p.id,
              sampleKey,
              observedAt: now,
              likes: m.like_count,
              replies: m.reply_count,
              reposts: m.retweet_count,
              quotes: m.quote_count,
              views:
                Number.isSafeInteger(m.impression_count) &&
                m.impression_count! >= 0 &&
                m.impression_count! <= 2147483647
                  ? m.impression_count!
                  : null,
            },
          });
          await tx.post.update({
            where: { id: p.id },
            data: { lastObservationId: observation.id },
          });
        }
        if (
          !old ||
          old.qualification !== qualification ||
          old.reasonCode !== reasonCode ||
          options.correction
        )
          await tx.contributionDecision.create({
            data: {
              postId: p.id,
              qualification,
              reasonCode,
              ruleVersion: raid.ruleVersion,
              evidence: { authorId: p.author_id, enrollmentId: enrollment?.id || null, sampleKey },
            },
          });
        if (enrollment)
          await tx.postSubmission.updateMany({
            where: { raidId, postId: p.id, enrollmentId: enrollment.id },
            data: { status: qualification, reasonCode },
          });
        if (raid.activeResultId)
          await tx.raid.update({ where: { id: raidId }, data: { trackingPhase: 'FINALIZING' } });
      }
      await requalifyDuplicates(tx, raidId);
    },
    { timeout: 30000 },
  );
}

export async function markTrackingUnavailable(
  raidId: string,
  ids: string[],
  missing: boolean,
  correction = false,
  reasonCode = 'POST_UNAVAILABLE',
) {
  await db.$transaction(
    async (tx) => {
      await lockTracking(tx, raidId);
      const raid = await tx.raid.findUniqueOrThrow({ where: { id: raidId } });
      if (raid.activeResultId && !correction) return;
      if (correction && raid.activeResultId)
        await tx.raid.update({ where: { id: raidId }, data: { trackingPhase: 'FINALIZING' } });
      for (const id of ids) {
        const p = await tx.post.findFirst({ where: { id, raidId } });
        if (!p) continue;
        await tx.post.update({
          where: { id },
          data: {
            availability: missing ? 'UNAVAILABLE' : 'DATA_INCOMPLETE',
            ...(missing
              ? {
                  text: '',
                  normalized: '',
                  qualification: 'EXCLUDED',
                  reasonCode,
                }
              : {}),
          },
        });
        await tx.contributionDecision.create({
          data: {
            postId: id,
            qualification: missing ? 'EXCLUDED' : p.qualification,
            reasonCode: missing ? reasonCode : 'LOOKUP_INCOMPLETE',
            ruleVersion: p.ruleVersion,
            evidence: { missing, observedAt: new Date().toISOString() },
          },
        });
      }
    },
    { timeout: 30000 },
  );
}
