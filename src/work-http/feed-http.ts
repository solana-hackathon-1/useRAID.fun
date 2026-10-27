import { InternalId } from '../contracts/ids';
import { createErrorEnvelope, type ErrorCode } from '../contracts/protocol';
import { WorkError } from '../work-loop/contracts';
import { FeedPageSchema, FeedQuerySchema } from '../work-loop/feed-contracts';

export class FeedHttpError extends Error {
  constructor(readonly status: 429) {
    super('HTTP_RATE_LIMITED');
    this.name = 'FeedHttpError';
  }
}
/** Transport-neutral host: the host owns the feature flag, rate limiting, SQL and transaction. No session is involved. */
export interface FeedHttpHost {
  readonly version: 'v1';
  requestId(): string;
  /** False while the feature flag is off; the route then answers as if it did not exist. */
  available(): boolean;
  rateLimit(request: Request): void | Promise<void>;
  feed(query: unknown): Promise<unknown>;
}
/** Public data, but ordering and availability change by the second: never serve a stale or shared-cache copy. */
export const feedHeaders = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});
const respond = (code: ErrorCode, id: string) => {
  const result = createErrorEnvelope(code, id);
  return Response.json(result.body, { status: result.status, headers: feedHeaders });
};
/** Strict query parsing: unknown or repeated parameters are refused rather than ignored. */
function readQuery(request: Request): unknown {
  const query: Record<string, string | number> = {};
  for (const [name, value] of new URL(request.url).searchParams) {
    if (name in query) return null;
    if (name === 'limit') {
      if (!/^\d{1,3}$/.test(value)) return null;
      query[name] = Number(value);
    } else query[name] = value;
  }
  return query;
}
export function createFeedHandlers(host: FeedHttpHost) {
  if (
    host?.version !== 'v1' ||
    ['requestId', 'available', 'rateLimit', 'feed'].some(
      (name) => typeof host[name as keyof FeedHttpHost] !== 'function',
    )
  )
    throw new WorkError('STORAGE_CONTRACT');
  function correlation() {
    try {
      const id = InternalId.safeParse(host.requestId());
      if (id.success) return id.data;
    } catch {}
    return crypto.randomUUID();
  }
  return {
    async GET(request: Request) {
      const id = correlation();
      try {
        if (request.method !== 'GET') {
          return Response.json(
            {
              error: {
                code: 'METHOD_NOT_ALLOWED',
                message: 'Method not allowed.',
                retryable: false,
                requestId: id,
              },
            },
            { status: 405, headers: feedHeaders },
          );
        }
        if (!host.available()) return respond('NOT_FOUND', id);
        await host.rateLimit(request);
        const parsed = FeedQuerySchema.safeParse(readQuery(request));
        if (!parsed.success) return respond('INVALID_COMMAND', id);
        const page = FeedPageSchema.safeParse(await host.feed(parsed.data));
        // A malformed or over-shared host result is never forwarded to a visitor.
        if (!page.success) return respond('SERVICE_UNAVAILABLE', id);
        return Response.json(page.data, { headers: feedHeaders });
      } catch (error) {
        if (error instanceof FeedHttpError) return respond('RATE_LIMITED', id);
        if (error instanceof WorkError && error.code === 'INVALID_INPUT')
          return respond('INVALID_COMMAND', id);
        return respond('SERVICE_UNAVAILABLE', id);
      }
    },
  };
}
