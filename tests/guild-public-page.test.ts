import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('../src/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/auth')>()),
  publicRateLimit: async () => undefined,
}));
import Page, { dynamic, generateMetadata } from '../src/app/guilds/[slug]/page';
import Loading from '../src/app/guilds/[slug]/loading';
import GuildNotFound from '../src/app/guilds/[slug]/not-found';
import { GUILD_PUBLIC_PAGE_SIZE } from '../src/lib/guild-public-page';
import { db } from '../src/lib/db';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
import {
  draftUpdate,
  publishedUpdate,
  syntheticGuild,
  syntheticPerson,
  withdrawUpdate,
} from './helpers/guild-public-page-fixture';

const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const props = (slug: string, searchParams: Record<string, string | string[]> = {}) => ({
  params: Promise.resolve({ slug }),
  searchParams: Promise.resolve(searchParams),
});
const render = async (slug: string, searchParams?: Record<string, string | string[]>) =>
  renderToStaticMarkup(await Page(props(slug, searchParams)));
const original = process.env.GUILD_PUBLIC_READS_ENABLED;
afterEach(() => {
  if (original === undefined) delete process.env.GUILD_PUBLIC_READS_ENABLED;
  else process.env.GUILD_PUBLIC_READS_ENABLED = original;
});

describe('T015 public Guild page without a database', () => {
  it.each([undefined, '', 'TRUE', '1', 'true '])(
    'answers not-found and generic metadata while the flag is %j',
    async (flag) => {
      if (flag === undefined) delete process.env.GUILD_PUBLIC_READS_ENABLED;
      else process.env.GUILD_PUBLIC_READS_ENABLED = flag;
      await expect(Page(props('any-guild'))).rejects.toThrow('NOT_FOUND');
      const metadata = await generateMetadata(props('any-guild'));
      expect(JSON.stringify(metadata)).not.toContain('any-guild');
      expect(metadata).toMatchObject({ robots: { index: false } });
    },
  );
  it.each([
    ['Bad_Slug', {}],
    ['a'.repeat(101), {}],
    ['good-slug', { before: 'not-a-uuid' }],
    [
      'good-slug',
      { before: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'] },
    ],
  ])('refuses a malformed slug or cursor %s %j before any read', async (slug, query) => {
    process.env.GUILD_PUBLIC_READS_ENABLED = 'true';
    await expect(Page(props(slug, query))).rejects.toThrow('NOT_FOUND');
  });
  it('is rendered per request with accessible loading and not-found states', () => {
    expect(dynamic).toBe('force-dynamic');
    const loading = renderToStaticMarkup(createElement(Loading));
    expect(loading).toContain('role="status"');
    expect(loading).toContain('Loading Guild');
    const missing = renderToStaticMarkup(createElement(GuildNotFound));
    expect(missing).toContain('Guild not found');
    expect(missing).toContain('href="/"');
  });
});

integration('T015 public Guild page over real PostgreSQL', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
    process.env.GUILD_PUBLIC_READS_ENABLED = 'true';
  });
  afterAll(() => db.$disconnect());

  it('renders only the approved projection and published updates; no private ids, drafts or withdrawn text', async () => {
    const { founder, operator, activationRef, guild } = await syntheticGuild(
      'public-page-guild',
      'Synthetic Page Guild',
      'A synthetic <em>description</em> & more',
    );
    const delegate = await syntheticPerson();
    const first = await publishedUpdate(founder, guild.id, 'First news', 'Line one\nline two');
    await publishedUpdate(founder, guild.id, 'Second news', 'Hello <script>alert(1)</script>');
    await draftUpdate(founder, guild.id, 'Secret draft title', 'Secret draft body');
    const gone = await publishedUpdate(founder, guild.id, 'Withdrawn title', 'Withdrawn body');
    await withdrawUpdate(founder, guild.id, gone);

    const html = await render('public-page-guild');
    expect(html).toContain('<h1>Synthetic Page Guild</h1>');
    expect(html).toContain('A synthetic &lt;em&gt;description&lt;/em&gt; &amp; more');
    expect(html).toContain('public-page-guild');
    expect(html).toContain('First news');
    expect(html).toContain('Line one\nline two');
    expect(html).toContain('Hello &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    const published = await db.$queryRawUnsafe<{ publishedAt: Date }[]>(
      `SELECT "publishedAt" FROM "GuildUpdate" WHERE "id"=$1::uuid`,
      first,
    );
    expect(html).toContain(`dateTime="${published[0].publishedAt.toISOString()}"`);
    expect(html).toContain('Second news');
    expect(html.indexOf('Second news')).toBeLessThan(html.indexOf('First news'));
    for (const secret of [
      'Secret draft',
      'Withdrawn',
      founder.accountId,
      founder.sessionHash,
      operator.accountId,
      delegate.accountId,
      activationRef,
      guild.id,
      'founderAccountId',
      'authorAccountId',
    ])
      expect(html).not.toContain(secret);
    expect(html).not.toContain('Load more');

    const metadata = await generateMetadata(props('public-page-guild'));
    expect(metadata).toEqual({
      title: 'Synthetic Page Guild',
      description: 'A synthetic <em>description</em> & more',
      robots: { index: false, follow: false },
    });
  });

  it('shows the empty state and answers not-found for an unknown Guild', async () => {
    await syntheticGuild('quiet-guild', 'Quiet Guild', '');
    const html = await render('quiet-guild');
    expect(html).toContain('No published updates yet');
    expect(html).not.toContain('Load more');
    await expect(Page(props('no-such-guild'))).rejects.toThrow('NOT_FOUND');
    const metadata = await generateMetadata(props('no-such-guild'));
    expect(JSON.stringify(metadata)).not.toContain('no-such-guild');
  });

  it('pages older updates through the public cursor with a keyboard-reachable link', async () => {
    const { founder, guild } = await syntheticGuild('busy-guild', 'Busy Guild', 'Busy');
    for (let i = 1; i <= GUILD_PUBLIC_PAGE_SIZE + 1; i++)
      await publishedUpdate(founder, guild.id, `Update number ${i}.`, `Body ${i}`);
    const html = await render('busy-guild');
    expect(html).toContain(`Update number ${GUILD_PUBLIC_PAGE_SIZE + 1}.`);
    expect(html).not.toContain('Update number 1.');
    const link =
      /<a[^>]*href="\/guilds\/busy-guild\?before=([0-9a-f-]{36})"[^>]*>Load more updates<\/a>/.exec(
        html,
      );
    expect(link).not.toBeNull();
    const older = await render('busy-guild', { before: link![1] });
    expect(older).toContain('Update number 1.');
    expect(older).not.toContain(`Update number ${GUILD_PUBLIC_PAGE_SIZE + 1}.`);
    expect(older).not.toContain('Load more');
    expect(older).toContain('href="/guilds/busy-guild"');
  });

  it('drops a withdrawn update on the very next render (no cached copy)', async () => {
    const { founder, guild } = await syntheticGuild('takedown-guild', 'Takedown Guild', 'x');
    const id = await publishedUpdate(founder, guild.id, 'Mistaken post', 'Oops');
    expect(await render('takedown-guild')).toContain('Mistaken post');
    await withdrawUpdate(founder, guild.id, id);
    expect(await render('takedown-guild')).not.toContain('Mistaken post');
  });
});
