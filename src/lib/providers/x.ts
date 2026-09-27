import { db } from '../db';
import { config } from '../config';
import type { XPost } from '../domain';
export class ProviderError extends Error {
  constructor(
    message: string,
    public retryAfter = 60,
  ) {
    super(message);
  }
}
export async function reserveUsage(units: number, raidId?: string, identity = false) {
  if (!identity && (!config.liveApproved || !process.env.X_BEARER_TOKEN))
    throw new ProviderError('Live collection has not passed the feasibility gate.', 300);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(729102)`;
    const settings = await tx.settings.upsert({ where: { id: 'global' }, create: {}, update: {} });
    if (!identity && !settings.collectionEnabled)
      throw new ProviderError('Collection is paused.', 300);
    const now = new Date();
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const day = new Date(now.toISOString().slice(0, 10));
    const usage = await tx.providerUsage.aggregate({
      where: { provider: 'x', at: { gte: month } },
      _sum: { reservedCents: true },
    });
    const calls = await tx.providerUsage.count({ where: { provider: 'x', at: { gte: day } } });
    // Conservative upper-bound accounting: no daily deduplication discount assumed.
    const cents = Math.ceil(units * (identity ? 1 : 0.5));
    if (
      (usage._sum.reservedCents || 0) + cents > settings.cutoffCents ||
      calls >= settings.dailyRequestLimit
    )
      throw new ProviderError('Collection budget or daily request limit reached.', 900);
    return tx.providerUsage.create({
      data: {
        provider: 'x',
        raidId,
        units,
        reservedCents: cents,
        reason: identity ? 'X identity lookup reservation' : 'Upper-bound post read reservation',
      },
    });
  });
}
async function xRead(path: string, params: URLSearchParams, units: number, raidId: string) {
  const reservation = await reserveUsage(units, raidId);
  const response = await fetch(`https://api.x.com/2/${path}?${params}`, {
    headers: { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}` },
    signal: AbortSignal.timeout(20000),
    cache: 'no-store',
  });
  if (!response.ok) {
    const reset = Number(response.headers.get('x-rate-limit-reset')) * 1000;
    throw new ProviderError(
      `X returned ${response.status}${response.status === 401 ? ' (credentials expired or invalid)' : ''}.`,
      response.status === 429 ? Math.max(60, Math.ceil((reset - Date.now()) / 1000) || 900) : 60,
    );
  }
  const body = await response.json();
  await db.providerUsage.update({
    where: { id: reservation.id },
    data: {
      units: body.data?.length || 0,
      reservedCents: Math.ceil((body.data?.length || 0) * 0.5),
      reason: 'Observed post reads; no deduplication discount',
    },
  });
  return body as {
    data?: XPost[];
    meta?: { next_token?: string; newest_id?: string };
    errors?: { resource_id?: string; type?: string }[];
  };
}
const fields = 'author_id,created_at,entities,public_metrics,referenced_tweets';
export async function searchPosts(raid: {
  id: string;
  tag: string;
  startsAt: Date;
  endsAt: Date;
  sinceId: string | null;
  nextToken: string | null;
  searchEndAt: Date | null;
}) {
  const end = new Date(
    Math.min(+raid.endsAt, raid.searchEndAt ? +raid.searchEndAt : Date.now() - 10000),
  );
  if (+end <= +raid.startsAt) return { data: [] as XPost[] };
  const p = new URLSearchParams({
    query: `@${config.handle} #${raid.tag} -is:retweet`,
    'tweet.fields': fields,
    max_results: '100',
    start_time: raid.startsAt.toISOString(),
    end_time: end.toISOString(),
  });
  if (raid.sinceId) p.set('since_id', raid.sinceId);
  if (raid.nextToken) p.set('next_token', raid.nextToken);
  return xRead('tweets/search/recent', p, 100, raid.id);
}
export async function lookupPosts(ids: string[], raidId: string) {
  return xRead(
    'tweets',
    new URLSearchParams({ ids: ids.join(','), 'tweet.fields': fields }),
    ids.length,
    raidId,
  );
}
