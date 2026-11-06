import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  profile: vi.fn(),
  updates: vi.fn(),
  list: vi.fn(),
}));
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
vi.mock('../src/lib/guild-public-host', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/guild-public-host')>()),
  readGuildFromHost: hoisted.profile,
  readGuildUpdatesFromHost: hoisted.updates,
  readGuildDirectoryFromHost: hoisted.list,
}));
import ProfilePage, { generateMetadata } from '../src/app/guilds/[slug]/page';
import DirectoryPage from '../src/app/guilds/page';
import { GuildStorageError } from '../src/guild-profiles/guild-storage-contracts';

const GUILD_ID = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const profile = (description = 'We build things.') => ({
  id: GUILD_ID,
  slug: 'alpha-guild',
  name: 'Alpha Guild',
  description,
  primaryToken: null,
});
const UPDATE = {
  id: '00000000-0000-4000-8000-000000000001',
  title: 'First news',
  body: 'Hello',
  publishedAt: '2026-10-01T10:00:00.000Z',
};
const props = (searchParams: Record<string, string> = {}) => ({
  params: Promise.resolve({ slug: 'alpha-guild' }),
  searchParams: Promise.resolve(searchParams),
});
const renderProfile = async (searchParams?: Record<string, string>) =>
  renderToStaticMarkup(await ProfilePage(props(searchParams)));
const original = process.env.GUILD_PUBLIC_READS_ENABLED;
beforeEach(() => {
  vi.clearAllMocks();
  process.env.GUILD_PUBLIC_READS_ENABLED = 'true';
  hoisted.profile.mockResolvedValue(profile());
  hoisted.updates.mockResolvedValue({ updates: [], nextCursor: null });
});
afterEach(() => {
  if (original === undefined) delete process.env.GUILD_PUBLIC_READS_ENABLED;
  else process.env.GUILD_PUBLIC_READS_ENABLED = original;
});

describe('T015-W02 public Guild profile states', () => {
  it('says plainly that no Raid history is published, without a score or standing', async () => {
    const html = await renderProfile();
    expect(html).toContain('aria-labelledby="guild-track-record-heading"');
    expect(html).toContain('No Raid history is published for this Guild yet.');
    expect(html).toContain('not a rating');
    expect(html).not.toMatch(/\b\d+\s*\/\s*100\b|\bscore\b|\bNEW\b|RESTRICTED/i);
  });

  it('shows the no-history state only on the first page of updates', async () => {
    hoisted.updates.mockResolvedValue({ updates: [UPDATE], nextCursor: null });
    const html = await renderProfile({ before: '00000000-0000-4000-8000-000000000002' });
    expect(html).not.toContain('No Raid history is published');
  });

  it('names an empty description instead of leaving a blank header', async () => {
    hoisted.profile.mockResolvedValue(profile(''));
    expect(await renderProfile()).toContain('No description published yet.');
  });

  it('keeps the profile and says updates are unavailable when only the updates read fails', async () => {
    hoisted.updates.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.7:5432 secret-host'));
    const html = await renderProfile();
    expect(html).toContain('<h1>Alpha Guild</h1>');
    expect(html).toContain('role="status"');
    expect(html).toContain('Updates cannot be loaded right now.');
    expect(html).toContain('href="/guilds/alpha-guild"');
    expect(html).not.toContain('No published updates yet.');
    expect(html).not.toContain('ECONNREFUSED');
    expect(html).not.toContain('secret-host');
  });

  it('still fails loudly when the updates projection breaks its contract', async () => {
    hoisted.updates.mockResolvedValue({
      updates: [{ ...UPDATE, authorAccountId: 'acct-1' }],
      nextCursor: null,
    });
    await expect(renderProfile()).rejects.toThrow('GUILD_PUBLIC_CONTRACT');
  });

  it('still answers not-found when the updates read says the Guild is gone', async () => {
    hoisted.updates.mockRejectedValue(new GuildStorageError('NOT_FOUND'));
    await expect(renderProfile()).rejects.toThrow('NOT_FOUND');
  });
});

describe('T015-W01 / T015-C09 public Guild pages expose only approved fields', () => {
  const forbidden = [
    GUILD_ID,
    'founderAccountId',
    'authorAccountId',
    'payout',
    'annex',
    'beneficiary',
    'escrow',
    'sessionHash',
  ];
  it('profile HTML and metadata carry no id, authority, payout or annex field', async () => {
    hoisted.updates.mockResolvedValue({
      updates: [UPDATE],
      nextCursor: '00000000-0000-4000-8000-000000000001',
    });
    const html = await renderProfile();
    const metadata = JSON.stringify(await generateMetadata(props()));
    for (const word of forbidden) {
      expect(html.toLowerCase()).not.toContain(word.toLowerCase());
      expect(metadata.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  it('rejects a host profile carrying an extra private field instead of rendering it', async () => {
    hoisted.profile.mockResolvedValue({ ...profile(), founderAccountId: 'acct-founder' });
    await expect(renderProfile()).rejects.toThrow('GUILD_PUBLIC_CONTRACT');
  });

  it('directory HTML carries no id, authority, payout or annex field and rejects extra fields', async () => {
    hoisted.list.mockResolvedValue({
      guilds: [{ slug: 'alpha-guild', name: 'Alpha Guild', description: 'We build things.' }],
      nextCursor: null,
    });
    const html = renderToStaticMarkup(await DirectoryPage({ searchParams: Promise.resolve({}) }));
    for (const word of forbidden) expect(html.toLowerCase()).not.toContain(word.toLowerCase());
    hoisted.list.mockResolvedValue({
      guilds: [{ slug: 'alpha-guild', name: 'Alpha Guild', description: '', payoutWallet: 'x' }],
      nextCursor: null,
    });
    await expect(DirectoryPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'GUILD_PUBLIC_CONTRACT',
    );
  });
});

describe('T015-W02 Guild directory states', () => {
  it('names a Guild with no description instead of an empty card', async () => {
    hoisted.list.mockResolvedValue({
      guilds: [{ slug: 'quiet-guild', name: 'Quiet Guild', description: '' }],
      nextCursor: null,
    });
    const html = renderToStaticMarkup(await DirectoryPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('No description published yet.');
  });
});
