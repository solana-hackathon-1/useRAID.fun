import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  limit: vi.fn(),
  list: vi.fn(),
  headers: new Headers({ 'x-test-ip': '203.0.113.9' }),
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
vi.mock('../src/lib/guild-public-host', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/guild-public-host')>()),
  readGuildDirectoryFromHost: hoisted.list,
}));
import Page, { dynamic, generateMetadata } from '../src/app/guilds/page';
import Loading from '../src/app/guilds/loading';
import { GUILD_DIRECTORY_PAGE_SIZE } from '../src/lib/guild-public-page';
import { HttpError } from '../src/lib/auth';

const props = (searchParams: Record<string, string | string[]> = {}) => ({
  searchParams: Promise.resolve(searchParams),
});
const render = async (searchParams?: Record<string, string | string[]>) =>
  renderToStaticMarkup(await Page(props(searchParams)));
const entry = (slug: string, name = slug.toUpperCase(), description = '') => ({
  slug,
  name,
  description,
});
const original = process.env.GUILD_PUBLIC_READS_ENABLED;
beforeEach(() => {
  vi.clearAllMocks();
  hoisted.limit.mockResolvedValue(undefined);
  process.env.GUILD_PUBLIC_READS_ENABLED = 'true';
});
afterEach(() => {
  if (original === undefined) delete process.env.GUILD_PUBLIC_READS_ENABLED;
  else process.env.GUILD_PUBLIC_READS_ENABLED = original;
});

describe('T015 Guild directory page', () => {
  it.each([undefined, '', 'TRUE', '1', 'true '])(
    'shows a not-enabled notice, reads nothing and is noindex while the flag is %j',
    async (flag) => {
      if (flag === undefined) delete process.env.GUILD_PUBLIC_READS_ENABLED;
      else process.env.GUILD_PUBLIC_READS_ENABLED = flag;
      const html = await render();
      expect(html).toContain('not open yet');
      expect(html).not.toContain('Load more');
      expect(hoisted.list).not.toHaveBeenCalled();
      expect(hoisted.limit).not.toHaveBeenCalled();
      expect(await generateMetadata()).toMatchObject({ robots: { index: false, follow: false } });
    },
  );

  it('lists Guilds as links to their public page with an accessible heading and breadcrumb', async () => {
    hoisted.list.mockResolvedValue({
      guilds: [entry('alpha-guild', 'Alpha <b>Guild</b>', 'First & foremost.')],
      nextCursor: null,
    });
    const html = await render();
    expect(html).toContain('<h1>Guilds</h1>');
    expect(html).toContain('href="/guilds/alpha-guild"');
    expect(html).toContain('Alpha &lt;b&gt;Guild&lt;/b&gt;');
    expect(html).not.toContain('<b>');
    expect(html).toContain('First &amp; foremost.');
    expect(html).toContain('aria-label="Breadcrumb"');
    expect(html).not.toContain('Load more');
    expect(hoisted.list).toHaveBeenCalledWith({ limit: GUILD_DIRECTORY_PAGE_SIZE });
  });

  it('shortens a long description to an excerpt', async () => {
    hoisted.list.mockResolvedValue({
      guilds: [entry('long-guild', 'Long', 'word '.repeat(200))],
      nextCursor: null,
    });
    const html = await render();
    expect(html).toContain('…');
    expect(html.length).toBeLessThan(2500);
  });

  it('offers a keyboard-reachable Load more link carrying only the slug cursor, and a way back', async () => {
    hoisted.list.mockResolvedValue({ guilds: [entry('b-guild')], nextCursor: 'b-guild' });
    const first = await render();
    expect(first).toContain('href="/guilds?after=b-guild"');
    expect(first).toContain('Load more Guilds');
    expect(first).not.toContain('Back to first Guilds');
    hoisted.list.mockResolvedValue({ guilds: [entry('c-guild')], nextCursor: null });
    const second = await render({ after: 'b-guild' });
    expect(hoisted.list).toHaveBeenLastCalledWith({
      limit: GUILD_DIRECTORY_PAGE_SIZE,
      after: 'b-guild',
    });
    expect(second).toContain('Back to first Guilds');
    expect(second).not.toContain('Load more');
  });

  it('shows an empty state with no Load more link', async () => {
    hoisted.list.mockResolvedValue({ guilds: [], nextCursor: null });
    const html = await render();
    expect(html).toContain('No Guilds are listed yet');
  });

  it.each([
    [{ after: 'Bad_Slug' }],
    [{ after: 'a'.repeat(101) }],
    [{ after: ['a-guild', 'b-guild'] }],
  ])('answers not-found for a malformed cursor %j before any read', async (query) => {
    await expect(Page(props(query))).rejects.toThrow('NOT_FOUND');
    expect(hoisted.list).not.toHaveBeenCalled();
  });

  it('ignores other query parameters', async () => {
    hoisted.list.mockResolvedValue({ guilds: [], nextCursor: null });
    await render({ limit: '500', before: 'x' });
    expect(hoisted.list).toHaveBeenCalledWith({ limit: GUILD_DIRECTORY_PAGE_SIZE });
  });

  it('uses the Guild API budget (120 per 60 s, shared fallback 600) and shows a throttled notice without reading', async () => {
    hoisted.limit.mockRejectedValue(new HttpError(429, 'Too many requests. Try again later.'));
    const html = await render();
    const [request, scope, limit, seconds, shared] = hoisted.limit.mock.calls[0];
    expect((request as Request).headers.get('x-test-ip')).toBe('203.0.113.9');
    expect([scope, limit, seconds, shared]).toEqual(['guild-public', 120, 60, 600]);
    expect(html).toContain('Too many requests');
    expect(hoisted.list).not.toHaveBeenCalled();
    expect(await generateMetadata()).toMatchObject({ robots: { index: false } });
  });

  it('never renders a host result that carries more than the approved fields', async () => {
    hoisted.list.mockResolvedValue({
      guilds: [{ ...entry('leaky-guild'), founderAccountId: 'acct-secret' }],
      nextCursor: null,
    });
    await expect(Page(props())).rejects.toThrow('GUILD_PUBLIC_CONTRACT');
  });

  it('lets a non-throttle read failure reach the error boundary', async () => {
    hoisted.list.mockRejectedValue(new Error('database is down'));
    await expect(Page(props())).rejects.toThrow('database is down');
  });

  it('is rendered per request, noindex, with an accessible loading state', async () => {
    expect(dynamic).toBe('force-dynamic');
    expect(await generateMetadata()).toEqual({
      title: 'Guilds',
      description: expect.any(String),
      robots: { index: false, follow: false },
    });
    const loading = renderToStaticMarkup(createElement(Loading));
    expect(loading).toContain('role="status"');
    expect(loading).toContain('Loading Guilds');
  });
});
