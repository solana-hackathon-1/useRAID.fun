import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  cookie: vi.fn(),
  list: vi.fn(),
  updates: vi.fn(),
}));
vi.mock('../src/lib/auth', async (original) => ({
  ...(await original<typeof import('../src/lib/auth')>()),
  currentUser: mocks.user,
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: mocks.cookie }) }));
vi.mock('../src/lib/guild-profile-host', () => ({ listManagedGuildsState: mocks.list }));
vi.mock('../src/lib/guild-updates-host', () => ({ listUpdatesState: mocks.updates }));

import ListPage from '../src/app/creator/guilds/page';
import DetailPage from '../src/app/creator/guilds/[slug]/page';
import { hash } from '../src/lib/auth-primitives';
import { GuildStorageError } from '../src/guild-profiles/guild-storage-contracts';

const id = (n: number) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;
const entry = (
  n: number,
  slug: string,
  kinds: string[],
  founder = kinds.includes('PROFILE'),
  name = slug.toUpperCase(),
) => ({
  guild: {
    version: 'v1',
    id: id(n),
    slug,
    name,
    description: 'About ' + slug,
    founderAccountId: kinds.includes('PROFILE') ? 'founder-account-9' : null,
    revision: 2,
    state: 'ACTIVE',
    primaryToken: null,
  },
  authority: { founder, kinds },
});
const state = (guilds: ReturnType<typeof entry>[], over = {}) => ({
  version: 'v1',
  guilds,
  writesAvailable: true,
  unavailableReason: null,
  ...over,
});
const renderList = async () => renderToStaticMarkup(await ListPage());
const renderDetail = async (slug: string) =>
  renderToStaticMarkup(await DetailPage({ params: Promise.resolve({ slug }) }));
const updatesState = (over = {}) => ({
  version: 'v1',
  updates: [],
  writesAvailable: true,
  unavailableReason: null,
  ...over,
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ id: 'me' });
  mocks.cookie.mockReturnValue({ value: 'session-cookie' });
  mocks.updates.mockResolvedValue(updatesState());
});
const actor = () => ({ accountId: 'me', sessionHash: hash('session-cookie') });

describe('own Guild list page', () => {
  it('asks a signed-out visitor to sign in and reads nothing', async () => {
    mocks.user.mockResolvedValue(null);
    const html = await renderList();
    expect(html).toContain('Sign in');
    expect(html).toContain('href="/creator/account"');
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it('shows an honest empty state', async () => {
    mocks.list.mockResolvedValue(state([]));
    const html = await renderList();
    expect(html).toContain('<h1>My Guilds</h1>');
    expect(html).toContain('You do not manage any Guilds yet.');
    expect(mocks.list).toHaveBeenCalledWith(actor());
  });
  it('links each Guild, names only the authority held, and escapes names', async () => {
    mocks.list.mockResolvedValue(
      state([
        entry(1, 'alpha-guild', ['PROFILE', 'WORK'], true, 'Alpha <b>x</b>'),
        entry(2, 'beta-guild', ['TREASURY'], false),
      ]),
    );
    const html = await renderList();
    expect(html).toContain('href="/creator/guilds/alpha-guild"');
    expect(html).toContain('href="/creator/guilds/beta-guild"');
    expect(html).toContain('Alpha &lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<b>x');
    expect(html).toContain('Founder');
    expect(html).toContain('Treasury');
    expect(html).not.toContain('founder-account-9');
    expect(html).not.toContain(id(1));
  });
  it('turns an expired session into a sign-in prompt and any other failure into a generic alert', async () => {
    mocks.list.mockRejectedValueOnce(new GuildStorageError('UNAUTHENTICATED'));
    expect(await renderList()).toContain('Sign in');
    mocks.list.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.1:5432'));
    const html = await renderList();
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('ECONNREFUSED');
  });
  it('rejects a list response that breaks the contract', async () => {
    mocks.list.mockResolvedValue({ version: 'v1', guilds: [{ guild: { slug: 'x' } }] });
    expect(await renderList()).toContain('role="alert"');
  });
});

describe('Guild management page', () => {
  it('asks a signed-out visitor to sign in and reads nothing', async () => {
    mocks.user.mockResolvedValue(null);
    expect(await renderDetail('alpha-guild')).toContain('Sign in');
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it('answers an unknown Guild and a Guild the caller holds nothing in with identical markup', async () => {
    mocks.list.mockResolvedValue(state([entry(1, 'mine-guild', ['PROFILE'])]));
    const unknown = await renderDetail('does-not-exist');
    const foreign = await renderDetail('someone-elses-guild');
    const malformed = await renderDetail('Not A Slug!');
    expect(unknown).toBe(foreign);
    expect(unknown).toBe(malformed);
    expect(unknown).toContain('not found or you do not manage it');
    expect(mocks.updates).not.toHaveBeenCalled();
  });
  it('gives a profile manager the editor and the updates manager', async () => {
    mocks.list.mockResolvedValue(state([entry(1, 'mine-guild', ['PROFILE', 'WORK'], true)]));
    const html = await renderDetail('mine-guild');
    expect(html).toContain('<h1>MINE-GUILD</h1>');
    expect(html).toContain('Save profile');
    expect(html).toContain('Save draft');
    expect(html).toContain('Saved revision 2');
    expect(html).toContain('Founder');
    expect(mocks.updates).toHaveBeenCalledWith(actor(), id(1));
  });
  it('shows a non-profile holder only a read-only summary of their own authority', async () => {
    mocks.list.mockResolvedValue(state([entry(1, 'work-guild', ['WORK'], false)]));
    const html = await renderDetail('work-guild');
    expect(html).toContain('Work');
    expect(html).toContain('Profile and update management need profile authority');
    expect(html).not.toContain('Save profile');
    expect(html).not.toContain('Save draft');
    expect(html).not.toContain('founder-account-9');
    expect(mocks.updates).not.toHaveBeenCalled();
  });
  it('tells a delegate they cannot publish and carries the writes-off state to the editor', async () => {
    mocks.list.mockResolvedValue(state([entry(1, 'delegate-guild', ['PROFILE'], false)]));
    mocks.list.mockResolvedValue(
      state([entry(1, 'delegate-guild', ['PROFILE'], false)], {
        writesAvailable: false,
        unavailableReason: 'DISABLED',
      }),
    );
    mocks.updates.mockResolvedValue(
      updatesState({ writesAvailable: false, unavailableReason: 'DISABLED' }),
    );
    const html = await renderDetail('delegate-guild');
    expect(html).toContain('Only the Founder can publish');
    expect(html).toContain('New drafts and publishing are currently unavailable');
    expect(html).toContain('Editing the profile is currently unavailable');
  });
  it('keeps the profile when the updates cannot be loaded, without leaking detail', async () => {
    mocks.list.mockResolvedValue(state([entry(1, 'mine-guild', ['PROFILE'], true)]));
    mocks.updates.mockRejectedValue(new Error('relation "GuildUpdate" does not exist'));
    const html = await renderDetail('mine-guild');
    expect(html).toContain('Save profile');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Updates could not be loaded');
    expect(html).not.toContain('relation');
    expect(html).not.toContain('Save draft');
  });
  it('treats a failing list as an alert, never as missing', async () => {
    mocks.list.mockRejectedValue(new Error('boom'));
    const html = await renderDetail('mine-guild');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('not found or you do not manage it');
  });
  it('is a dynamic, non-indexed page', async () => {
    const list = await import('../src/app/creator/guilds/page');
    const detail = await import('../src/app/creator/guilds/[slug]/page');
    expect(list.dynamic).toBe('force-dynamic');
    expect(detail.dynamic).toBe('force-dynamic');
    expect(list.metadata).toMatchObject({ robots: { index: false, follow: false } });
    expect(detail.metadata).toMatchObject({ robots: { index: false, follow: false } });
  });
});
