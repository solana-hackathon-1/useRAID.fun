import type { Prisma } from '@prisma/client';
import { db } from './db';
import { config } from './config';
import { demoRaids } from './demo';
import { metrics, momentum, interactions } from './domain';
import type { RaidView } from './types';
import type { Market } from './providers/market';
export async function getRaids(filter: Prisma.RaidWhereInput = {}): Promise<RaidView[]> {
  if (config.demo) return demoRaids();
  const now = new Date();
  const raids = await db.raid.findMany({
    where: {
      hidden: false,
      status: { in: Object.keys(filter).length ? ['ACTIVE', 'ENDED'] : ['ACTIVE'] },
      creator: { suspended: false },
      ...filter,
    },
    include: {
      token: true,
      posts: { where: { hidden: false, deleted: false } },
      snapshots: { where: { at: { gte: new Date(+now - 2 * 3600000) } }, orderBy: { at: 'asc' } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return raids.map((r) => {
    const m = metrics(r.posts, now);
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
      tag: r.tag,
      title: r.title,
      description: r.description,
      mint: r.mint,
      symbol: r.token.symbol,
      name: r.token.name,
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
      market: r.token.market as unknown as Market | null,
      marketAt: r.token.marketAt?.toISOString() || null,
      marketError: r.token.marketError,
      activity: r.posts
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
    : metrics(posts, new Date());
  return {
    mint,
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
