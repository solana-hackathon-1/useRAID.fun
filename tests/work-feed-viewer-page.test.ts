import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  available: vi.fn(),
  eligibility: vi.fn(),
  feed: vi.fn(),
  viewerFeed: vi.fn(),
  user: vi.fn(),
  cookie: vi.fn(),
}));
vi.mock('../src/lib/work-feed-host', () => ({
  workFeedAvailable: mocks.available,
  workFeedEligibilityAvailable: mocks.eligibility,
  readFeedFromHost: mocks.feed,
  readFeedForViewerFromHost: mocks.viewerFeed,
  readDetailFromHost: vi.fn(),
}));
vi.mock('../src/lib/auth', async (original) => ({
  ...(await original<typeof import('../src/lib/auth')>()),
  currentUser: mocks.user,
}));
vi.mock('../src/lib/work-workspace-host', () => ({
  workWorkspaceConfiguration: vi.fn(),
  readMyRaidsFromHost: vi.fn(),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: mocks.cookie }) }));

import { loadFeed } from '../src/lib/work-feed-page';
import { hash } from '../src/lib/auth-primitives';

const page = { items: [], nextCursor: null, sort: 'newest', rewardComparable: false };
const viewerPage = { ...page, viewer: { eligibility: { x: 'ELIGIBLE' } } };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.available.mockReturnValue(true);
  mocks.eligibility.mockReturnValue(true);
  mocks.feed.mockResolvedValue(page);
  mocks.viewerFeed.mockResolvedValue(viewerPage);
  mocks.user.mockResolvedValue({ id: 'someone' });
  mocks.cookie.mockReturnValue({ value: 'session-cookie' });
});
describe('feed loader: Eligible for me is computed on the server for the signed-in viewer', () => {
  it('reads through the viewer path with the session actor and reports the server-computed map', async () => {
    const loaded = await loadFeed({ category: 'design' });
    expect(mocks.feed).not.toHaveBeenCalled();
    expect(mocks.viewerFeed).toHaveBeenCalledWith(
      { category: 'design', sort: 'newest', limit: 20 },
      { accountId: 'someone', sessionHash: hash('session-cookie') },
      false,
    );
    expect(loaded).toMatchObject({
      status: 'READY',
      viewer: { status: 'READY', eligibleOnly: false, eligibility: { x: 'ELIGIBLE' } },
    });
  });
  it('turns the eligible=1 box into a server-side filter and keeps it out of the public query', async () => {
    const loaded = await loadFeed({ eligible: '1', category: 'design' });
    expect(mocks.viewerFeed).toHaveBeenCalledWith(
      { category: 'design', sort: 'newest', limit: 20 },
      expect.anything(),
      true,
    );
    expect(loaded).toMatchObject({ viewer: { status: 'READY', eligibleOnly: true } });
  });
  it('refuses any other eligible value and a repeated one, without reading', async () => {
    expect(await loadFeed({ eligible: 'yes' })).toMatchObject({ status: 'INVALID' });
    expect(await loadFeed({ eligible: ['1', '1'] })).toMatchObject({ status: 'INVALID' });
    expect(mocks.viewerFeed).not.toHaveBeenCalled();
    expect(mocks.feed).not.toHaveBeenCalled();
  });
  it('shows nothing extra and uses the public read while the feature flag is off', async () => {
    mocks.eligibility.mockReturnValue(false);
    const loaded = await loadFeed({ eligible: '1' });
    expect(mocks.viewerFeed).not.toHaveBeenCalled();
    expect(mocks.user).not.toHaveBeenCalled();
    expect(loaded).toMatchObject({ status: 'READY', viewer: { status: 'OFF' } });
    expect(mocks.feed).toHaveBeenCalledWith({ sort: 'newest', limit: 20 });
  });
  it('asks a signed-out visitor to sign in and ignores the filter instead of guessing', async () => {
    mocks.user.mockResolvedValue(null);
    const loaded = await loadFeed({ eligible: '1' });
    expect(mocks.viewerFeed).not.toHaveBeenCalled();
    expect(loaded).toMatchObject({ viewer: { status: 'SIGNED_OUT' } });
    mocks.user.mockRejectedValue(new Error('db'));
    expect(await loadFeed({})).toMatchObject({ viewer: { status: 'SIGNED_OUT' } });
  });
  it('falls back to the plain public feed, saying the check is unavailable, when the check fails', async () => {
    mocks.viewerFeed.mockRejectedValue(new Error('postgres://secret'));
    const loaded = await loadFeed({ eligible: '1' });
    expect(mocks.feed).toHaveBeenCalledTimes(1);
    expect(loaded).toMatchObject({ status: 'READY', page, viewer: { status: 'UNAVAILABLE' } });
    expect(JSON.stringify(loaded)).not.toContain('secret');
  });
});
