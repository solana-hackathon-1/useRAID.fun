import { describe, expect, it } from 'vitest';
import {
  createGuildPublicHandlers,
  GuildPublicHttpError,
  type GuildPublicHttpHost,
} from '../src/guild-profiles/guild-public-http';
import { GuildStorageError } from '../src/guild-profiles/guild-storage-contracts';

const guildId = '11111111-1111-4111-8111-111111111111';
const updateId = '22222222-2222-4222-8222-222222222222';
const guild = {
  id: guildId,
  slug: 'synthetic-guild',
  name: 'Synthetic Guild',
  description: 'A synthetic Guild.',
  primaryToken: null,
};
const page = {
  updates: [
    {
      id: updateId,
      title: 'Shipped',
      body: 'We shipped.',
      publishedAt: '2026-10-29T06:00:00.000Z',
    },
  ],
  nextCursor: null,
};
function host(overrides: Partial<GuildPublicHttpHost> = {}) {
  const seen: unknown[] = [];
  const value: GuildPublicHttpHost = {
    version: 'v1',
    requestId: () => 'request-1',
    available: () => true,
    rateLimit: () => undefined,
    guild: async (slug) => (seen.push(['guild', slug]), guild),
    updates: async (slug, query) => (seen.push(['updates', slug, query]), page),
    ...overrides,
  };
  return { value, seen };
}
const get = (path = '/api/v1/guilds/synthetic-guild', method = 'GET') =>
  new Request('https://example.test' + path, { method });
const body = async (response: Response) => (await response.json()) as Record<string, any>;

describe('public Guild HTTP boundary', () => {
  it('answers the approved public profile as uncacheable JSON without a session or origin', async () => {
    const { value, seen } = host();
    const response = await createGuildPublicHandlers(value).GUILD(get(), 'synthetic-guild');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await body(response)).toEqual(guild);
    expect(seen).toEqual([['guild', 'synthetic-guild']]);
  });

  it('pages published updates with typed limit and cursor only', async () => {
    const { value, seen } = host();
    const handlers = createGuildPublicHandlers(value);
    const response = await handlers.UPDATES(
      get(`/api/v1/guilds/synthetic-guild/updates?limit=5&before=${updateId}`),
      'synthetic-guild',
    );
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual(page);
    expect(seen).toEqual([['updates', 'synthetic-guild', { limit: 5, before: updateId }]]);
    for (const query of [
      '?limit=0x5',
      '?limit=1&limit=2',
      '?limit=21',
      '?before=not-a-uuid',
      '?surprise=1',
      `?before=${updateId}&before=${updateId}`,
    ]) {
      const refused = await handlers.UPDATES(
        get('/api/v1/guilds/synthetic-guild/updates' + query),
        'synthetic-guild',
      );
      expect(refused.status, query).toBe(422);
      expect((await body(refused)).error.code, query).toBe('INVALID_COMMAND');
    }
    expect(seen).toHaveLength(1);
  });

  it('answers as if the feature did not exist while the flag is off, touching nothing', async () => {
    const calls: string[] = [];
    const { value } = host({
      available: () => false,
      rateLimit: () => void calls.push('rateLimit'),
      guild: async () => (calls.push('guild'), guild),
      updates: async () => (calls.push('updates'), page),
    });
    const handlers = createGuildPublicHandlers(value);
    for (const response of [
      await handlers.GUILD(get(), 'synthetic-guild'),
      await handlers.UPDATES(get('/api/v1/guilds/synthetic-guild/updates'), 'synthetic-guild'),
    ]) {
      expect(response.status).toBe(404);
      expect((await body(response)).error.code).toBe('NOT_FOUND');
    }
    expect(calls).toEqual([]);
  });

  it('refuses every method but GET, before the flag, throttle or any read', async () => {
    const { value, seen } = host();
    const handlers = createGuildPublicHandlers(value);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await handlers.GUILD(get(undefined, method), 'synthetic-guild');
      expect(response.status, method).toBe(405);
      expect((await body(response)).error.code).toBe('METHOD_NOT_ALLOWED');
    }
    expect(seen).toEqual([]);
  });

  it('validates the slug before reading and keeps unknown Guilds indistinguishable', async () => {
    const { value, seen } = host({
      guild: async () => {
        throw new GuildStorageError('NOT_FOUND');
      },
    });
    const handlers = createGuildPublicHandlers(value);
    for (const slug of ['Upper', 'a b', '-x', 'x'.repeat(101), '']) {
      const response = await handlers.GUILD(get(), slug);
      expect(response.status, slug).toBe(422);
    }
    expect(seen).toEqual([]);
    const missing = await handlers.GUILD(get(), 'no-such-guild');
    expect(missing.status).toBe(404);
    expect((await body(missing)).error.code).toBe('NOT_FOUND');
    const withQuery = await handlers.GUILD(
      get('/api/v1/guilds/synthetic-guild?x=1'),
      'synthetic-guild',
    );
    expect(withQuery.status).toBe(422);
  });

  it('never forwards a result that is malformed, over-shared or for another Guild', async () => {
    const bad: unknown[] = [
      { ...guild, founderAccountId: 'founder-1' },
      { ...guild, slug: 'another-guild' },
      { ...guild, description: undefined },
      null,
    ];
    for (const result of bad) {
      const { value } = host({ guild: async () => result });
      const response = await createGuildPublicHandlers(value).GUILD(get(), 'synthetic-guild');
      expect(response.status).toBe(503);
      expect(JSON.stringify(await body(response))).not.toContain('founder-1');
    }
    const oversized = {
      updates: Array.from({ length: 21 }, () => page.updates[0]),
      nextCursor: null,
    };
    const leaky = {
      updates: [{ ...page.updates[0], authorAccountId: 'author-1' }],
      nextCursor: null,
    };
    for (const result of [oversized, leaky, { updates: [], nextCursor: 'not-a-uuid' }]) {
      const { value } = host({ updates: async () => result });
      const response = await createGuildPublicHandlers(value).UPDATES(
        get('/api/v1/guilds/synthetic-guild/updates'),
        'synthetic-guild',
      );
      expect(response.status).toBe(503);
      expect(JSON.stringify(await body(response))).not.toContain('author-1');
    }
  });

  it('maps throttling and unexpected failures to fixed safe answers', async () => {
    const throttled = host({
      rateLimit: () => {
        throw new GuildPublicHttpError(429);
      },
    });
    const limited = await createGuildPublicHandlers(throttled.value).GUILD(
      get(),
      'synthetic-guild',
    );
    expect(limited.status).toBe(429);
    expect(throttled.seen).toEqual([]);
    const broken = host({
      guild: async () => {
        throw new Error('connection to db.internal:5432 refused');
      },
    });
    const failed = await createGuildPublicHandlers(broken.value).GUILD(get(), 'synthetic-guild');
    expect(failed.status).toBe(503);
    expect(JSON.stringify(await body(failed))).not.toContain('db.internal');
  });

  it('rejects an incomplete host and falls back to a fresh request id', async () => {
    const { value } = host();
    expect(() =>
      createGuildPublicHandlers({ ...value, updates: undefined } as unknown as GuildPublicHttpHost),
    ).toThrow();
    const odd = host({ requestId: () => 'not an id!' });
    const response = await createGuildPublicHandlers(odd.value).GUILD(get(), 'synthetic-guild');
    expect(response.status).toBe(200);
  });
});
