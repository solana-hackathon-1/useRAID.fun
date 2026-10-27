import { describe, expect, it } from 'vitest';
import { createFeedHandlers, FeedHttpError, type FeedHttpHost } from '../src/work-http/feed-http';
import { WorkError } from '../src/work-loop/contracts';

const page = { items: [], nextCursor: null, sort: 'newest', rewardComparable: false };
function host(overrides: Partial<FeedHttpHost> = {}) {
  const seen: unknown[] = [];
  const value: FeedHttpHost = {
    version: 'v1',
    requestId: () => 'request-1',
    available: () => true,
    rateLimit: () => undefined,
    feed: async (query) => (seen.push(query), page),
    ...overrides,
  };
  return { value, seen };
}
const get = (query = '', method = 'GET') =>
  new Request('https://example.test/api/v1/work/feed' + query, { method });
const body = async (response: Response) => (await response.json()) as Record<string, any>;

describe('public Raid feed HTTP boundary', () => {
  it('parses typed filters, answers privately uncacheable JSON and never needs a session or origin', async () => {
    const { value, seen } = host();
    const response = await createFeedHandlers(value).GET(
      get('?category=design&sort=deadline&limit=5&difficulty=D'),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await body(response)).toEqual(page);
    expect(seen).toEqual([{ category: 'design', sort: 'deadline', limit: 5, difficulty: 'D' }]);
  });
  it('rejects unknown, repeated, malformed and over-long parameters before the host is asked', async () => {
    const { value, seen } = host();
    const handlers = createFeedHandlers(value);
    for (const query of [
      '?unknown=1',
      '?category=a&category=b',
      '?limit=abc',
      '?limit=1.5',
      '?limit=-1',
      '?cursor=' + 'x'.repeat(2000),
    ]) {
      const response = await handlers.GET(get(query));
      expect(response.status, query).toBe(422);
      expect((await body(response)).error.code).toBe('INVALID_COMMAND');
    }
    expect(seen).toEqual([]);
  });
  it('maps an invalid host query, a closed feature, throttling, contract drift and wrong methods safely', async () => {
    const invalid = createFeedHandlers(
      host({
        feed: async () => {
          throw new WorkError('INVALID_INPUT');
        },
      }).value,
    );
    expect((await invalid.GET(get('?sort=reward'))).status).toBe(422);
    const closed = createFeedHandlers(host({ available: () => false }).value);
    const off = await closed.GET(get());
    expect(off.status).toBe(404);
    expect((await body(off)).error.code).toBe('NOT_FOUND');
    const limited = createFeedHandlers(
      host({
        rateLimit: () => {
          throw new FeedHttpError(429);
        },
      }).value,
    );
    expect((await limited.GET(get())).status).toBe(429);
    const drift = createFeedHandlers(
      host({ feed: async () => ({ ...page, items: [{ listingId: 'x', reviewerAccountId: 'r' }] }) })
        .value,
    );
    const broken = await drift.GET(get());
    expect(broken.status).toBe(503);
    expect(JSON.stringify(await body(broken))).not.toContain('reviewer');
    const wrong = await createFeedHandlers(host().value).GET(get('', 'POST'));
    expect(wrong.status).toBe(405);
    const crash = createFeedHandlers(
      host({
        feed: async () => {
          throw new Error('connection string postgres://secret');
        },
      }).value,
    );
    const hidden = await crash.GET(get());
    expect(hidden.status).toBe(503);
    expect(JSON.stringify(await body(hidden))).not.toContain('secret');
  });
  it('refuses a host that omits a required port', () => {
    expect(() => createFeedHandlers({ version: 'v1' } as unknown as FeedHttpHost)).toThrow();
  });
});
