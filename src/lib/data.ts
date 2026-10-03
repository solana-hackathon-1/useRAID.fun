import { scoreContributions } from './tracking-domain';
import type { ResultPayload } from './tracking-review';
import type { Prisma } from '@prisma/client';
import { db } from './db';
import { config } from './config';
import { demoRaids } from './demo';
import { metrics, momentum, interactions } from './domain';
import type { RaidView } from './types';
import type { Market } from './providers/market';
import { displayIdentity } from './token-identity';
const LIST_TTL_MS = 10000;
let listMemo: { at: number; value: Promise<RaidView[]> } | null = null;
export function resetRaidListMemo() {
  listMemo = null;
}
// The unfiltered discovery list is public and polled, so concurrent callers share one query for a few seconds.
export function getRaids(filter: Prisma.RaidWhereInput = {}): Promise<RaidView[]> {
  if (config.demo) return Promise.resolve(demoRaids());
  if (Object.keys(filter).length) return loadRaids(filter);
  if (!listMemo || Date.now() - listMemo.at > LIST_TTL_MS) {
    const value = loadRaids({});
    const entry = { at: Date.now(), value };
    listMemo = entry;
    value.catch(() => {
      if (listMemo === entry) listMemo = null;
    });
  }
  return listMemo.value;
}
async function loadRaids(filter: Prisma.RaidWhereInput): Promise<RaidView[]> {
  const now = new Date();
  // List mode reads the latest snapshot and a short activity feed; detail pages compute from every post.
  const detail = 'id' in filter || 'mint' in filter;
  const raids = await db.raid.findMany({
    where: {
      hidden: false,
      status: { in: Object.keys(filter).length ? ['ACTIVE', 'ENDED'] : ['ACTIVE'] },
      creator: { suspended: false },
      ...filter,
    },
    include: {
      token: true,
      results: { orderBy: { version: 'desc' }, take: 1 },
      posts: detail
        ? { where: { hidden: false, deleted: false } }
        : {
            where: {
              hidden: false,
              deleted: false,
              OR: [
                { qualification: 'LEGACY' },
                {
                  qualification: 'QUALIFIED',
                  availability: 'AVAILABLE',
                  reviewStatus: { not: 'FLAGGED' },
                },
              ],
            },
            orderBy: { createdAt: 'desc' },
            take: 20,
          },
      snapshots: { where: { at: { gte: new Date(+now - 2 * 3600000) } }, orderBy: { at: 'asc' } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return raids.map((r) => {
    const result = r.results[0]?.payload as unknown as ResultPayload | undefined;
    const scoringPosts = result
      ? result.contributions.map((p) => ({ ...p, text: '', createdAt: new Date(p.createdAt) }))
      : r.posts;
    const latest = r.snapshots.at(-1);
    const m =
      !detail && !result
        ? {
            score: latest?.score ?? 0,
            raiders: latest?.raiders ?? 0,
            posts: latest?.posts ?? 0,
            interactions: latest?.interactions ?? 0,
          }
        : r.trackingVersion === 2
          ? scoreContributions(scoringPosts, result?.scoringVersion ?? r.scoringVersion)
          : metrics(r.posts, now);
    const identity = displayIdentity(r);
    const target = +now - 3600000;
    const baseline = r.snapshots.filter((s) => +s.at <= target && +s.at >= target - 300000).at(-1);
    const fresh = !!r.observedAt && +now - +r.observedAt < 600000 && r.coverage === 'complete';
    const window = r.snapshots.filter((s) => +s.at >= target);
    const complete =
      fresh &&
      baseline?.complete &&
      window.length > 0 &&
      +window[0].at - +baseline.at <= 360000 &&
      +now - +window[window.length - 1].at <= 360000 &&
      window.every((s, i) => s.complete && (i === 0 || +s.at - +window[i - 1].at <= 360000));
    return {
      id: r.id,
      trackingVersion: r.trackingVersion,
      fundingAsset: r.fundingAsset,
      poolUnits: r.poolUnits?.toString() || null,
      imageUri: identity.imageUri,
      tag: r.tag,
      title: r.title,
      description: r.description,
      mint: r.mint,
      symbol: identity.symbol,
      name: identity.name,
      status: r.endsAt <= now ? 'ENDED' : r.status,
      startsAt: r.startsAt.toISOString(),
      endsAt: r.endsAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
      ...m,
      momentum: complete ? momentum(m.score, baseline) : null,
      delta: complete ? m.score - baseline.score : null,
      observedAt: r.observedAt?.toISOString() || null,
      freshness: !r.observedAt
        ? 'unavailable'
        : r.coverage === 'partial'
          ? 'partial'
          : fresh
            ? 'fresh'
            : 'stale',
      coverage: r.coverage,
      market: (r.token?.market as unknown as Market | null) || null,
      marketAt: r.token?.marketAt?.toISOString() || null,
      marketError: r.token?.marketError || null,
      activity: r.posts
        .filter(
          (p) =>
            r.trackingVersion !== 2 ||
            (p.qualification === 'QUALIFIED' &&
              p.availability === 'AVAILABLE' &&
              p.reviewStatus !== 'FLAGGED'),
        )
        .sort((a, b) => +b.createdAt - +a.createdAt)
        .slice(0, 20)
        .map((p) => ({
          id: p.id,
          authorId: p.authorId,
          text: p.text,
          createdAt: p.createdAt.toISOString(),
          interactions: interactions(p),
        })),
      history: r.snapshots.map((s) => ({ at: s.at.toISOString(), score: s.score })),
    };
  });
}
export async function getRaid(id: string) {
  return (await getRaids({ id })).find((r) => r.id === id) || null;
}
export async function getToken(mint: string) {
  const raids = (await getRaids({ mint })).filter((r) => r.mint === mint);
  if (!raids.length) return null;
  const posts = config.demo
    ? []
    : await db.post.findMany({
        where: {
          raid: {
            mint,
            hidden: false,
            status: { in: ['ACTIVE', 'ENDED'] },
            creator: { suspended: false },
          },
          hidden: false,
          deleted: false,
        },
      });
  const totals = config.demo
    ? {
        raiders: raids[0].raiders,
        posts: raids[0].posts,
        interactions: raids[0].interactions,
        score: raids[0].score,
      }
    : !raids.some((r) => r.trackingVersion === 2)
      ? metrics(posts, new Date())
      : {
          score: raids.reduce((sum, r) => sum + r.score, 0),
          raiders: new Set(
            posts
              .filter(
                (p) =>
                  p.qualification === 'LEGACY' ||
                  (p.qualification === 'QUALIFIED' &&
                    p.availability === 'AVAILABLE' &&
                    p.reviewStatus !== 'FLAGGED'),
              )
              .map((p) => p.authorId),
          ).size,
          posts: raids.reduce((sum, r) => sum + r.posts, 0),
          interactions: raids.reduce((sum, r) => sum + r.interactions, 0),
        };
  const metadataSource = config.demo
    ? 'MARKET'
    : (await db.token.findUnique({ where: { mint }, select: { metadataSource: true } }))
        ?.metadataSource || 'CREATOR';
  return {
    mint,
    metadataSource,
    symbol: raids[0].symbol,
    name: raids[0].name,
    raids,
    totals,
    market: raids[0].market,
    marketAt: raids[0].marketAt,
    marketError: raids[0].marketError,
    ...aggregateFreshness(raids),
  };
}

export function aggregateFreshness(raids: RaidView[]): Pick<RaidView, 'freshness' | 'observedAt'> {
  const observed = raids
    .map((r) => r.observedAt)
    .filter((s): s is string => s !== null)
    .sort();
  const freshness: RaidView['freshness'] = config.demo
    ? 'demo'
    : !observed.length
      ? 'unavailable'
      : raids.some((r) => r.freshness === 'unavailable' || r.freshness === 'partial')
        ? 'partial'
        : raids.some((r) => r.freshness === 'stale')
          ? 'stale'
          : 'fresh';
  return { observedAt: observed[0] || null, freshness };
}
// A visitor counts as returning only after discovery views on two different days.
export async function returningVisitors(since: Date) {
  const rows = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM (
      SELECT visitor FROM "Event"
      WHERE type = 'discovery_view' AND visitor IS NOT NULL AND at >= ${since}
      GROUP BY visitor
      HAVING count(DISTINCT date_trunc('day', at)) >= 2
    ) v`;
  return rows[0]?.n ?? 0;
}
