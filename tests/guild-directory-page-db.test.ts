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
import Page from '../src/app/guilds/page';
import { GUILD_DIRECTORY_PAGE_SIZE } from '../src/lib/guild-public-page';
import { guildPublicHandlers } from '../src/lib/guild-public-http';
import { db } from '../src/lib/db';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
import { syntheticGuild } from './helpers/guild-public-page-fixture';

const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const render = async (searchParams: Record<string, string> = {}) =>
  renderToStaticMarkup(await Page({ searchParams: Promise.resolve(searchParams) }));
const original = process.env.GUILD_PUBLIC_READS_ENABLED;
afterEach(() => {
  if (original === undefined) delete process.env.GUILD_PUBLIC_READS_ENABLED;
  else process.env.GUILD_PUBLIC_READS_ENABLED = original;
});

integration('T015 Guild directory page and API over real PostgreSQL', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
    process.env.GUILD_PUBLIC_READS_ENABLED = 'true';
  });
  afterAll(() => db.$disconnect());

  it('renders every Guild across pages by cursor, with no private ids, and the API shows the same list', async () => {
    const total = GUILD_DIRECTORY_PAGE_SIZE + 1;
    const created = [];
    for (let i = 0; i < total; i++) {
      const slug = 'dir-guild-' + String(i).padStart(2, '0');
      created.push({ slug, ...(await syntheticGuild(slug, 'Directory Guild ' + i, 'About ' + i)) });
    }
    const first = await render();
    const second = await render({
      after: 'dir-guild-' + String(GUILD_DIRECTORY_PAGE_SIZE - 1).padStart(2, '0'),
    });
    expect(first.match(/href="\/guilds\/dir-guild-\d\d"/g)).toHaveLength(GUILD_DIRECTORY_PAGE_SIZE);
    expect(first).toContain(
      'href="/guilds?after=dir-guild-' +
        String(GUILD_DIRECTORY_PAGE_SIZE - 1).padStart(2, '0') +
        '"',
    );
    expect(second.match(/href="\/guilds\/dir-guild-\d\d"/g)).toHaveLength(1);
    expect(second).not.toContain('Load more');
    expect(second).toContain('Back to first Guilds');
    for (const html of [first, second])
      for (const guild of created)
        for (const secret of [
          guild.guild.id,
          guild.founder.accountId,
          guild.founder.sessionHash,
          guild.operator.accountId,
          guild.activationRef,
          'founderAccountId',
        ])
          expect(html).not.toContain(secret);

    const api = await guildPublicHandlers.GUILDS(
      new Request('https://host.example/api/v1/guilds?limit=20'),
    );
    expect(api.status).toBe(200);
    const listed = (await api.json()) as { guilds: { slug: string }[]; nextCursor: string | null };
    expect(listed.guilds.map((g) => g.slug)).toEqual(created.map((g) => g.slug));
    expect(listed.nextCursor).toBeNull();
    expect(JSON.stringify(listed)).not.toContain(created[0].guild.id);
  });

  it('shows the empty state, and the API answers an empty page', async () => {
    expect(await render()).toContain('No Guilds are listed yet');
    const api = await guildPublicHandlers.GUILDS(new Request('https://host.example/api/v1/guilds'));
    expect(await api.json()).toEqual({ guilds: [], nextCursor: null });
  });

  it('answers the API as not found while the flag is off', async () => {
    delete process.env.GUILD_PUBLIC_READS_ENABLED;
    const api = await guildPublicHandlers.GUILDS(new Request('https://host.example/api/v1/guilds'));
    expect(api.status).toBe(404);
  });
});
