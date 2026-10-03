import { trackingEnabled } from './config';
import { ingestTracking, markTrackingUnavailable } from './tracking';
import { scoreContributions } from './tracking-domain';
import { db } from './db';
import { config } from './config';
import { eligible, metrics, normalize, type XPost } from './domain';
import { lookupOutcome, lookupPosts, searchPosts } from './providers/x';
import { enqueue } from './queue';
import { completeImpressionTarget } from './raid-progress';
// Final-pass lookups that stay unresolved this many attempts are excluded (below JOB_MAX_ATTEMPTS).
export const LOOKUP_ESCALATE_ATTEMPT = 5;
export async function ingest(raidId: string, posts: XPost[], sampleKey?: string) {
  const raid = await db.raid.findUniqueOrThrow({ where: { id: raidId } });
  if (raid.trackingVersion === 2) return ingestTracking(raidId, posts, { sampleKey });
  const tags = new Set(
    (await db.raid.findMany({ select: { tag: true } })).map((r) => r.tag.toLowerCase()),
  );
  for (const p of posts) {
    if (!eligible(p, raid, config.handle, tags)) {
      await db.post.updateMany({
        where: { id: p.id, raidId },
        data: { deleted: true, text: '', normalized: '' },
      });
      continue;
    }
    const existing = await db.post.findUnique({ where: { id: p.id } });
    if (existing && existing.raidId !== raidId) continue;
    const counts = p.public_metrics;
    if (
      !counts ||
      ![counts.like_count, counts.reply_count, counts.retweet_count, counts.quote_count].every(
        (n) => Number.isInteger(n) && n >= 0,
      )
    )
      throw new Error('X omitted valid public metrics; preserving the previous observation.');
    const data = {
      text: p.text,
      normalized: normalize(p.text),
      authorId: p.author_id,
      createdAt: new Date(p.created_at),
      observedAt: new Date(),
      deleted: false,
      likes: counts?.like_count || 0,
      replies: counts?.reply_count || 0,
      reposts: counts?.retweet_count || 0,
      quotes: counts?.quote_count || 0,
    };
    await db.post.upsert({
      where: { id: p.id, raidId },
      create: { id: p.id, raidId, ...data },
      update: data,
    });
  }
}
export async function snapshot(raidId: string, complete: boolean) {
  const now = new Date();
  const at = new Date(Math.floor(+now / 60000) * 60000);
  const posts = await db.post.findMany({ where: { raidId } });
  const raid = await db.raid.findUniqueOrThrow({ where: { id: raidId } });
  const calculated = raid.trackingVersion === 2 ? scoreContributions(posts) : metrics(posts, now);
  const data = {
    score: calculated.score,
    raiders: calculated.raiders,
    posts: calculated.posts,
    interactions: calculated.interactions,
    complete,
    scoreVersion: raid.scoringVersion,
  };
  if (complete)
    await db.snapshot.upsert({
      where: { raidId_at: { raidId, at } },
      create: { raidId, at, ...data },
      update: data,
    });
  else await db.snapshot.createMany({ data: [{ raidId, at, ...data }], skipDuplicates: true });
  if (complete && raid.impressionTarget) await completeImpressionTarget(raidId);
}
export async function collect(raidId: string, sampleKey?: string) {
  let raid = await db.raid.findUniqueOrThrow({ where: { id: raidId }, include: { creator: true } });
  if (
    (raid.trackingVersion === 2 && (!trackingEnabled() || !!raid.activeResultId)) ||
    raid.hidden ||
    raid.creator.suspended ||
    !['ACTIVE', 'ENDED'].includes(raid.status) ||
    raid.finalRefreshed
  )
    return;
  if (!raid.searchEndAt)
    raid = await db.raid.update({
      where: { id: raidId },
      data: { searchEndAt: new Date(Math.min(+raid.endsAt, Date.now() - 10000)) },
      include: { creator: true },
    });
  const result = await searchPosts(raid);
  if (result.errors?.length)
    throw new Error('X search returned partial errors; collection will retry.');
  await ingest(raidId, result.data || [], sampleKey);
  const newest = result.meta?.newest_id || raid.pendingNewestId;
  const unchanged = {
    id: raidId,
    searchEndAt: raid.searchEndAt,
    nextToken: raid.nextToken,
    endsAt: raid.endsAt,
  };
  if (result.meta?.next_token) {
    const moved = await db.raid.updateMany({
      where: unchanged,
      data: {
        nextToken: result.meta.next_token,
        pendingNewestId: raid.pendingNewestId || newest,
        coverage: 'partial',
      },
    });
    if (!moved.count) return;
    await enqueue(
      'collect',
      `page:${raidId}:${raid.searchEndAt?.toISOString()}:${result.meta.next_token}`,
      { raidId },
    );
  } else {
    const moved = await db.raid.updateMany({
      where: unchanged,
      data: {
        sinceId: raid.pendingNewestId || newest || raid.sinceId,
        nextToken: null,
        pendingNewestId: null,
        searchEndAt: null,
      },
    });
    if (!moved.count) return;
    await enqueue('refresh', `refresh:${raidId}:${Date.now()}`, {
      raidId,
      after: '',
      final: !!raid.searchEndAt && +raid.searchEndAt >= +raid.endsAt,
      coveredUntil: raid.searchEndAt?.toISOString(),
    });
  }
  await snapshot(raidId, false);
}
export async function refresh(
  raidId: string,
  after: string,
  final: boolean,
  coveredUntil?: string,
  sampleKey?: string,
  attempt = 1,
) {
  const raid = await db.raid.findUniqueOrThrow({
    where: { id: raidId },
    include: { creator: true },
  });
  if (
    raid.hidden ||
    raid.creator.suspended ||
    (raid.trackingVersion === 2 && (!trackingEnabled() || raid.activeResultId))
  )
    return;
  const posts = await db.post.findMany({
    where: { raidId, deleted: false, ...(after ? { id: { gt: after } } : {}) },
    orderBy: { id: 'asc' },
    take: 100,
  });
  if (posts.length) {
    const result = await lookupPosts(
      posts.map((p) => p.id),
      raidId,
    );
    await ingest(raidId, result.data || [], sampleKey);
    // Only explicit X resource errors mark a post gone, never a transport failure.
    const ids = posts.map((p) => p.id);
    const outcome = new Map(ids.map((id) => [id, lookupOutcome(result.errors, id)]));
    const returned = new Set((result.data || []).map((p) => p.id));
    const withOutcome = (kind: string) =>
      ids.filter((id) => !returned.has(id) && outcome.get(id) === kind);
    const missing = withOutcome('missing');
    const restricted = withOutcome('restricted');
    if (raid.trackingVersion === 2) {
      if (missing.length) await markTrackingUnavailable(raidId, missing, true);
      if (restricted.length)
        await markTrackingUnavailable(raidId, restricted, true, false, 'POST_RESTRICTED');
    } else if (missing.length || restricted.length)
      await db.post.updateMany({
        where: { id: { in: [...missing, ...restricted] }, raidId },
        data: { deleted: true, text: '', normalized: '' },
      });
    const accounted = new Set([...returned, ...missing, ...restricted]);
    const unresolved = ids.filter((id) => !accounted.has(id));
    if (unresolved.length) {
      if (final && attempt >= LOOKUP_ESCALATE_ATTEMPT) {
        if (raid.trackingVersion === 2)
          await markTrackingUnavailable(raidId, unresolved, true, false, 'LOOKUP_FAILED');
        else
          await db.post.updateMany({
            where: { id: { in: unresolved }, raidId },
            data: { deleted: true, text: '', normalized: '' },
          });
      } else {
        if (raid.trackingVersion === 2) await markTrackingUnavailable(raidId, unresolved, false);
        throw new Error('X returned incomplete lookup data.');
      }
    }
  }
  if (posts.length === 100) {
    await enqueue('refresh', `refresh:${raidId}:${posts.at(-1)!.id}:${Date.now()}`, {
      raidId,
      after: posts.at(-1)!.id,
      final,
      coveredUntil,
    });
  } else {
    // Read the cursors at write time so a late or stale refresh can neither undo nor outrun a newer pass.
    const done = await db.raid.updateMany({
      where: { id: raidId, nextToken: null, searchEndAt: null },
      data: {
        observedAt: new Date(),
        coverage: 'complete',
        collectionError: null,
        ...(final ? { finalRefreshed: true } : {}),
      },
    });
    if (!done.count) return;
    if (coveredUntil)
      await db.raid.updateMany({
        where: {
          id: raidId,
          OR: [{ coveredUntil: null }, { coveredUntil: { lt: new Date(coveredUntil) } }],
        },
        data: { coveredUntil: new Date(coveredUntil) },
      });
    await snapshot(raidId, true);
  }
}
