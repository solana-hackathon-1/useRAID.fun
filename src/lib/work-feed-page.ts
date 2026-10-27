import { FeedQuerySchema, type FeedPage, type FeedQuery } from '../work-loop/feed-contracts';
import { readFeedFromHost, workFeedAvailable } from './work-feed-host';

type Params = Record<string, string | string[] | undefined>;
export type LoadedFeed =
  | { status: 'UNAVAILABLE' }
  | { status: 'INVALID'; query: Partial<FeedQuery> }
  | { status: 'READY'; page: FeedPage; query: FeedQuery };
/** Server-side first paint of the public feed. Failures never expose detail. */
export async function loadFeed(params: Params): Promise<LoadedFeed> {
  if (!workFeedAvailable()) return { status: 'UNAVAILABLE' };
  const raw: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    // A repeated parameter is refused, never silently reduced to one of its values.
    if (Array.isArray(value)) return { status: 'INVALID', query: {} };
    raw[name] =
      name === 'limit' && /^\d{1,3}$/.test(value)
        ? Number(value)
        : name === 'closesBefore' && /^\d{4}-\d{2}-\d{2}$/.test(value)
          ? `${value}T00:00:00.000Z`
          : value;
  }
  const query = FeedQuerySchema.safeParse(raw);
  if (!query.success) return { status: 'INVALID', query: {} };
  try {
    return { status: 'READY', page: await readFeedFromHost(query.data), query: query.data };
  } catch {
    return { status: 'UNAVAILABLE' };
  }
}
