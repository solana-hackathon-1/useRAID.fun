import { describe, expect, it } from 'vitest';
import {
  createGuildPublicHandlers,
  GuildPublicHttpError,
  type GuildPublicHttpHost,
} from '../src/guild-profiles/guild-public-http';
import { GuildStorageError } from '../src/guild-profiles/guild-storage-contracts';

const directory = {
  guilds: [
    { slug: 'alpha-guild', name: 'Alpha Guild', description: 'First.' },
    { slug: 'bravo-guild', name: 'Bravo Guild', description: '' },
  ],
  nextCursor: 'bravo-guild',
};
function host(overrides: Partial<GuildPublicHttpHost> = {}) {
  const seen: unknown[] = [];
  const value: GuildPublicHttpHost = {
    version: 'v1',
    requestId: () => 'request-1',
    available: () => true,
    rateLimit: () => undefined,
    guild: async () => ({}),
    updates: async () => ({}),
    guilds: async (query) => (seen.push(query), directory),
    ...overrides,
  };
  return { value, seen };
}
const get = (query = '', method = 'GET') =>
  new Request('https://example.test/api/v1/guilds' + query, { method });
const body = async (response: Response) =>
  (await response.json()) as { error: { code: string } } & Record<string, unknown>;

describe('public Guild directory HTTP boundary', () => {
  it('answers the approved directory page as uncacheable JSON without a session', async () => {
    const { value, seen } = host();
    const response = await createGuildPublicHandlers(value).GUILDS(get('?limit=2&after=aaa'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await body(response)).toEqual(directory);
    expect(seen).toEqual([{ limit: 2, after: 'aaa' }]);
  });

  it('passes no query when none is given', async () => {
    const { value, seen } = host();
    expect((await createGuildPublicHandlers(value).GUILDS(get())).status).toBe(200);
    expect(seen).toEqual([{}]);
  });

  it.each([
    '?limit=0',
    '?limit=21',
    '?limit=1.5',
    '?limit=abc',
    '?limit=1&limit=2',
    '?after=Bad_Slug',
    '?after=' + 'a'.repeat(101),
    '?after=a&after=b',
    '?before=00000000-0000-4000-8000-000000000001',
    '?unknown=1',
  ])('refuses the query %s before reading', async (query) => {
    const { value, seen } = host();
    const response = await createGuildPublicHandlers(value).GUILDS(get(query));
    expect(response.status).toBe(422);
    expect((await body(response)).error.code).toBe('INVALID_COMMAND');
    expect(seen).toEqual([]);
  });

  it('answers not found and touches nothing while the flag is off', async () => {
    const { value, seen } = host({
      available: () => false,
      rateLimit: () => {
        throw new Error('throttle must not run');
      },
    });
    const response = await createGuildPublicHandlers(value).GUILDS(get());
    expect(response.status).toBe(404);
    expect(seen).toEqual([]);
  });

  it('answers not found when the host offers no directory read', async () => {
    const { value } = host({ guilds: undefined });
    expect((await createGuildPublicHandlers(value).GUILDS(get())).status).toBe(404);
  });

  it('refuses a host whose directory read is not a function', () => {
    const { value } = host({ guilds: 'x' as never });
    expect(() => createGuildPublicHandlers(value)).toThrow(GuildStorageError);
  });

  it('refuses other methods and throttles before reading', async () => {
    const { value, seen } = host({
      rateLimit: () => {
        throw new GuildPublicHttpError(429);
      },
    });
    const handlers = createGuildPublicHandlers(value);
    expect((await handlers.GUILDS(get('', 'POST'))).status).toBe(405);
    const limited = await handlers.GUILDS(get());
    expect(limited.status).toBe(429);
    expect(seen).toEqual([]);
  });

  it('maps storage errors to fixed answers and never forwards a malformed host result', async () => {
    const failing = (error: unknown) =>
      createGuildPublicHandlers(
        host({
          guilds: async () => {
            throw error;
          },
        }).value,
      ).GUILDS(get());
    expect((await failing(new GuildStorageError('INVALID_INPUT'))).status).toBe(422);
    expect((await failing(new Error('SELECT secret FROM x'))).status).toBe(503);
    for (const result of [
      null,
      { guilds: [], nextCursor: 5 },
      {
        guilds: [{ ...directory.guilds[0], id: '11111111-1111-4111-8111-111111111111' }],
        nextCursor: null,
      },
      { guilds: [{ ...directory.guilds[0], founderAccountId: 'acct' }], nextCursor: null },
      { guilds: [{ slug: 'Bad_Slug', name: 'x', description: '' }], nextCursor: null },
      { guilds: Array.from({ length: 21 }, () => directory.guilds[0]), nextCursor: null },
      { ...directory, extra: true },
    ]) {
      const { value } = host({ guilds: async () => result });
      const response = await createGuildPublicHandlers(value).GUILDS(get());
      expect(response.status).toBe(503);
      expect(JSON.stringify(await body(response))).not.toContain('acct');
    }
  });
});
