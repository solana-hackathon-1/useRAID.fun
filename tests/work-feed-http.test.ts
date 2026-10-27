import { describe, expect, it } from 'vitest';
import { createFeedHandlers, FeedHttpError, type FeedHttpHost } from '../src/work-http/feed-http';
import { WorkError } from '../src/work-loop/contracts';
import { DetailSchema } from '../src/work-loop/feed-contracts';

const page = { items: [], nextCursor: null, sort: 'newest', rewardComparable: false };
const listingId = '11111111-1111-4111-8111-111111111111';
const brief = DetailSchema.parse({
  listingId,
  termsVersionId: '22222222-2222-4222-8222-222222222222',
  guildId: 'synthetic-guild',
  title: 'Synthetic task',
  publicSummary: 'Summary.',
  category: 'documentation',
  difficulty: 'E',
  requiredSkills: [{ skillId: 'writing', minimumRank: 'E' }],
  participantKinds: ['HUMAN'],
  execution: 'SOLO',
  admission: 'INSTANT',
  rewards: [
    {
      assetKey: '["SOLANA","synthetic-work","NATIVE_SOL"]',
      assetId: { chain: 'SOLANA', networkIdentity: 'synthetic-work', kind: 'NATIVE_SOL' },
      decimals: 9,
      amount: '1',
    },
  ],
  commitmentDeadline: '2026-11-04T09:30:00.000Z',
  submissionDeadline: '2026-11-08T00:00:00.000Z',
  availableSlots: 1,
  funding: { mode: 'SIMULATED' },
  confidentiality: 'PUBLIC',
  outcome: 'Outcome.',
  deliverables: ['A'],
  acceptanceCriteria: ['B'],
  exclusions: [],
  dependencies: [],
  allowedToolsPolicy: 'Any.',
  startCondition: 'Ready.',
  deadlines: {
    commitment: '2026-11-04T09:30:00.000Z',
    preparation: '2026-11-05T09:30:00.000Z',
    submission: '2026-11-08T00:00:00.000Z',
    review: '2026-11-09T00:00:00.000Z',
    operationalClosure: '2026-11-10T00:00:00.000Z',
  },
  review: { evidence: 'Pinned commit.', maxRevisionRounds: 1 },
  rightsPolicy: 'R.',
  portfolioPolicy: 'P.',
  withdrawalPolicy: 'W.',
  terminationPolicy: 'T.',
  disputePolicy: 'D.',
  finalityPolicy: 'F.',
});
function host(overrides: Partial<FeedHttpHost> = {}) {
  const seen: unknown[] = [];
  const value: FeedHttpHost = {
    version: 'v1',
    requestId: () => 'request-1',
    available: () => true,
    rateLimit: () => undefined,
    feed: async (query) => (seen.push(query), page),
    detail: async (id) => (seen.push(id), brief),
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
  it('serves one public brief by listing id with the same safety, and answers a missing one as not found', async () => {
    const { value, seen } = host();
    const handlers = createFeedHandlers(value);
    const ok = await handlers.DETAIL(get(), listingId);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect((await body(ok)).title).toBe('Synthetic task');
    expect(seen).toEqual([listingId]);
    for (const bad of ['not-a-uuid', '../x', listingId + 'x']) {
      expect((await handlers.DETAIL(get(), bad)).status, bad).toBe(422);
    }
    expect((await handlers.DETAIL(get('?x=1'), listingId)).status).toBe(422);
    const missing = createFeedHandlers(
      host({
        detail: async () => {
          throw new WorkError('NOT_FOUND');
        },
      }).value,
    );
    const gone = await missing.DETAIL(get(), listingId);
    expect(gone.status).toBe(404);
    expect((await body(gone)).error.code).toBe('NOT_FOUND');
    const off = createFeedHandlers(host({ available: () => false }).value);
    expect((await off.DETAIL(get(), listingId)).status).toBe(404);
    const drift = createFeedHandlers(
      host({ detail: async () => ({ ...brief, reviewerAccountId: 'reviewer' }) }).value,
    );
    const broken = await drift.DETAIL(get(), listingId);
    expect(broken.status).toBe(503);
    expect(JSON.stringify(await body(broken))).not.toContain('reviewer');
    expect((await handlers.DETAIL(get('', 'POST'), listingId)).status).toBe(405);
  });
});
