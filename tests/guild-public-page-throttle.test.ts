import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  limit: vi.fn(),
  readGuild: vi.fn(),
  readUpdates: vi.fn(),
  headers: new Headers({ 'x-test-ip': '203.0.113.7' }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('next/headers', () => ({ headers: async () => hoisted.headers }));
vi.mock('../src/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/auth')>()),
  publicRateLimit: hoisted.limit,
}));
vi.mock('../src/lib/guild-public-host', () => ({
  guildPublicAvailable: () => true,
  readGuildFromHost: hoisted.readGuild,
  readGuildUpdatesFromHost: hoisted.readUpdates,
}));
import Page, { generateMetadata } from '../src/app/guilds/[slug]/page';
import { HttpError } from '../src/lib/auth';

const props = (slug: string) => ({
  params: Promise.resolve({ slug }),
  searchParams: Promise.resolve({}),
});

describe('T015 public Guild page throttle (#319)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => vi.clearAllMocks());

  it('uses the API budget (120 per 60 s, shared fallback 600) keyed from the request headers', async () => {
    hoisted.limit.mockRejectedValue(new HttpError(429, 'Too many requests. Try again later.'));
    await Page(props('good-guild'));
    const [request, scope, limit, seconds, shared] = hoisted.limit.mock.calls[0];
    expect((request as Request).headers.get('x-test-ip')).toBe('203.0.113.7');
    expect([scope, limit, seconds, shared]).toEqual(['guild-public', 120, 60, 600]);
  });

  it('shows a throttled page and generic metadata without reading storage when over the limit', async () => {
    hoisted.limit.mockRejectedValue(new HttpError(429, 'Too many requests. Try again later.'));
    const html = renderToStaticMarkup(await Page(props('good-guild')));
    expect(html).toContain('Too many requests');
    expect(html).not.toContain('good-guild');
    const metadata = await generateMetadata(props('good-guild'));
    expect(JSON.stringify(metadata)).not.toContain('good-guild');
    expect(metadata).toMatchObject({ robots: { index: false } });
    expect(hoisted.readGuild).not.toHaveBeenCalled();
    expect(hoisted.readUpdates).not.toHaveBeenCalled();
  });

  it('does not spend budget on a malformed slug', async () => {
    await expect(Page(props('Bad_Slug'))).rejects.toThrow('NOT_FOUND');
    expect(hoisted.limit).not.toHaveBeenCalled();
  });

  it('surfaces a non-throttle limiter failure as an error', async () => {
    hoisted.limit.mockRejectedValue(new Error('db down'));
    await expect(Page(props('good-guild'))).rejects.toThrow('db down');
    expect(hoisted.readGuild).not.toHaveBeenCalled();
  });
});
