import { db } from '../db';
import { config } from '../config';
import type { XPost } from '../domain';
export class ProviderError extends Error {
  constructor(
    message: string,
    public retryAfter = 60,
    public deferred = false,
    public status?: number,
  ) {
    super(message);
  }
}
export async function reserveUsage(units: number, raidId?: string, identity = false) {
  if (!identity && (!config.liveApproved || !process.env.X_BEARER_TOKEN))
    throw new ProviderError('Live collection has not passed the feasibility gate.', 300, true);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(729102)`;
    const settings = await tx.settings.upsert({ where: { id: 'global' }, create: {}, update: {} });
    if (!identity && !settings.collectionEnabled)
      throw new ProviderError('Collection is paused.', 300, true);
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
      throw new ProviderError('Collection budget or daily request limit reached.', 900, true);
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
async function xRead(path: string, params: URLSearchParams, units: number, raidId?: string) {
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`x-endpoint:${path}`}, 0))`;
    const state = await tx.xEndpointState.findUnique({ where: { key: path } });
    if (state?.blockedUntil && state.blockedUntil > new Date())
      throw new ProviderError(
        'X endpoint is waiting for its rate-limit reset.',
        Math.max(1, Math.ceil((+state.blockedUntil - Date.now()) / 1000)),
        true,
      );
    if (state?.remaining != null && state.resetAt && state.resetAt > new Date()) {
      if (state.remaining <= 0)
        throw new ProviderError(
          'X endpoint quota exhausted.',
          Math.max(1, Math.ceil((+state.resetAt - Date.now()) / 1000)),
          true,
        );
      await tx.xEndpointState.update({
        where: { key: path },
        data: { remaining: { decrement: 1 } },
      });
    }
  });
  const reservation = await reserveUsage(units, raidId);
  const response = await fetch(`https://api.x.com/2/${path}?${params}`, {
    headers: { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}` },
    signal: AbortSignal.timeout(20000),
    cache: 'no-store',
  }).catch(() => {
    throw new ProviderError('X is unreachable.', 60, true);
  });
  const remainingHeader = response.headers.get('x-rate-limit-remaining');
  const resetHeader = response.headers.get('x-rate-limit-reset');
  const resetSeconds = resetHeader ? Number(resetHeader) : NaN;
  const remaining = remainingHeader ? Number(remainingHeader) : NaN;
  const resetAt = Number.isFinite(resetSeconds) ? new Date(resetSeconds * 1000) : null;
  const blockedUntil =
    response.status === 429
      ? resetAt && resetAt > new Date()
        ? resetAt
        : new Date(Date.now() + 900000)
      : remaining === 0
        ? resetAt
        : null;
  const state = {
    ...(Number.isSafeInteger(remaining) ? { remaining } : {}),
    ...(resetAt ? { resetAt } : {}),
    blockedUntil,
    lastError: response.ok ? null : `X returned ${response.status}`,
    ...(response.ok ? { lastSuccessAt: new Date() } : {}),
  };
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`x-endpoint:${path}`}, 0))`;
    const current = await tx.xEndpointState.findUnique({ where: { key: path } });
    // Concurrent responses must not replenish quota or undo another request's 429.
    if (
      current?.resetAt &&
      resetAt &&
      +current.resetAt === +resetAt &&
      current.remaining !== null &&
      state.remaining !== undefined
    )
      state.remaining = Math.min(current.remaining, state.remaining);
    if (
      current?.blockedUntil &&
      current.blockedUntil > new Date() &&
      (!state.blockedUntil || current.blockedUntil > state.blockedUntil)
    )
      state.blockedUntil = current.blockedUntil;
    await tx.xEndpointState.upsert({
      where: { key: path },
      create: { key: path, ...state },
      update: state,
    });
  });
  if (!response.ok) {
    const reset = Number(response.headers.get('x-rate-limit-reset')) * 1000;
    throw new ProviderError(
      `X returned ${response.status}${response.status === 401 ? ' (credentials expired or invalid)' : ''}.`,
      response.status === 429 ? Math.max(60, Math.ceil((reset - Date.now()) / 1000) || 900) : 60,
      response.status === 429 || response.status >= 500,
      response.status,
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
    includes?: { users?: { id: string; username: string; name: string }[] };
  };
}
export function lookupOutcome(
  errors: { resource_id?: string; type?: string }[] | undefined,
  id: string,
): 'missing' | 'restricted' | 'unknown' {
  const types = (errors || []).filter((e) => e.resource_id === id).map((e) => e.type || '');
  if (types.some((t) => t.endsWith('/resource-not-found'))) return 'missing';
  if (
    types.some(
      (t) => t.endsWith('/not-authorized-for-resource') || t.endsWith('/resource-unavailable'),
    )
  )
    return 'restricted';
  return 'unknown';
}
const SEARCH_WINDOW_MS = 7 * 86400000;
const fields = 'author_id,created_at,entities,public_metrics,referenced_tweets';
export async function searchPosts(raid: {
  id: string;
  tag: string;
  startsAt: Date;
  endsAt: Date;
  sinceId: string | null;
  nextToken: string | null;
  searchEndAt: Date | null;
  officialHandle?: string;
  trackingVersion?: number;
  ruleVersion?: number;
  coveredUntil?: Date | null;
}) {
  const end = new Date(
    Math.min(+raid.endsAt, raid.searchEndAt ? +raid.searchEndAt : Date.now() - 10000),
  );
  const finalPass = !!raid.searchEndAt && +raid.searchEndAt >= +raid.endsAt;
  const wanted =
    raid.ruleVersion && raid.ruleVersion >= 4 && raid.coveredUntil && !finalPass
      ? Math.max(+raid.startsAt, +raid.coveredUntil - 1000)
      : +raid.startsAt;
  // X recent search rejects start_time beyond its 7-day window.
  const start = new Date(Math.max(wanted, Date.now() - SEARCH_WINDOW_MS + 60000));
  if (+end <= +start) return { data: [] as XPost[] };
  const p = new URLSearchParams({
    query:
      raid.trackingVersion === 2 && (raid.ruleVersion || 1) >= 3
        ? `@${raid.officialHandle} -is:retweet -is:reply`
        : `@${raid.trackingVersion === 2 ? raid.officialHandle : config.handle} #${raid.tag} -is:retweet`,
    'tweet.fields': fields,
    max_results: '100',
    start_time: start.toISOString(),
    end_time: end.toISOString(),
  });
  if (raid.sinceId) p.set('since_id', raid.sinceId);
  if (raid.nextToken) p.set('next_token', raid.nextToken);
  return xRead('tweets/search/recent', p, 100, raid.id);
}
export async function lookupPosts(ids: string[], raidId?: string) {
  return xRead(
    'tweets',
    new URLSearchParams({
      ids: ids.join(','),
      'tweet.fields': fields,
      expansions: 'author_id',
      'user.fields': 'username,name',
    }),
    ids.length,
    raidId,
  );
}
