import { InternalId } from '../contracts/ids';
import { createErrorEnvelope, type ErrorCode } from '../contracts/protocol';
import { WorkError } from '../work-loop/contracts';
import { z } from 'zod';
import { DetailSchema, FeedPageSchema, FeedQuerySchema } from '../work-loop/feed-contracts';

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
  detail(listingId: string): Promise<unknown>;
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
    ['requestId', 'available', 'rateLimit', 'feed', 'detail'].some(
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
  /** Shared envelope: method, flag, throttle, then the work; every failure is a safe, fixed answer. */
  async function run(request: Request, work: () => Promise<Response>) {
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
      return (await work()) ?? respond('SERVICE_UNAVAILABLE', id);
    } catch (error) {
      if (error instanceof FeedHttpError) return respond('RATE_LIMITED', id);
      if (error instanceof WorkError && error.code === 'INVALID_INPUT')
        return respond('INVALID_COMMAND', id);
      if (error instanceof WorkError && error.code === 'NOT_FOUND') return respond('NOT_FOUND', id);
      return respond('SERVICE_UNAVAILABLE', id);
    }
  }
  const unavailable = () => respond('SERVICE_UNAVAILABLE', correlation());
  return {
    GET(request: Request) {
      return run(request, async () => {
        const parsed = FeedQuerySchema.safeParse(readQuery(request));
        if (!parsed.success) return respond('INVALID_COMMAND', correlation());
        const page = FeedPageSchema.safeParse(await host.feed(parsed.data));
        // A malformed or over-shared host result is never forwarded to a visitor.
        return page.success ? Response.json(page.data, { headers: feedHeaders }) : unavailable();
      });
    },
    DETAIL(request: Request, listingId: string) {
      return run(request, async () => {
        const target = z.uuid().safeParse(listingId);
        if (!target.success || new URL(request.url).searchParams.size)
          return respond('INVALID_COMMAND', correlation());
        const brief = DetailSchema.safeParse(await host.detail(target.data));
        return brief.success ? Response.json(brief.data, { headers: feedHeaders }) : unavailable();
      });
    },
  };
}
