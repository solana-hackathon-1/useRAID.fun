import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  available: vi.fn(),
  feed: vi.fn(),
  detail: vi.fn(),
  user: vi.fn(),
  config: vi.fn(),
}));
vi.mock('../src/lib/work-feed-host', () => ({
  workFeedAvailable: mocks.available,
  readFeedFromHost: mocks.feed,
  readDetailFromHost: mocks.detail,
}));
vi.mock('../src/lib/auth', async (original) => ({
  ...(await original<typeof import('../src/lib/auth')>()),
  currentUser: mocks.user,
}));
vi.mock('../src/lib/work-workspace-host', () => ({
  workWorkspaceConfiguration: mocks.config,
}));
import { applyMode, loadDetail, loadFeed } from '../src/lib/work-feed-page';
import { WorkError } from '../src/work-loop/contracts';

const page = { items: [], nextCursor: null, sort: 'newest', rewardComparable: false };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.available.mockReturnValue(true);
  mocks.feed.mockResolvedValue(page);
});
describe('loadFeed', () => {
  it('is unavailable while the feature flag is off and never reads', async () => {
    mocks.available.mockReturnValue(false);
    expect(await loadFeed({})).toEqual({ status: 'UNAVAILABLE' });
    expect(mocks.feed).not.toHaveBeenCalled();
  });
  it('reads one typed query from plain search parameters, mapping a date to a UTC instant', async () => {
    const loaded = await loadFeed({
      category: 'design',
      limit: '5',
      closesBefore: '2026-11-10',
      difficulty: '',
    });
    expect(loaded).toMatchObject({ status: 'READY', page });
    expect(mocks.feed).toHaveBeenCalledWith({
      category: 'design',
      limit: 5,
      closesBefore: '2026-11-10T00:00:00.000Z',
      sort: 'newest',
    });
  });
  it('reports invalid filters without reading, and hides read failures', async () => {
    expect(await loadFeed({ sort: 'reward' })).toMatchObject({ status: 'INVALID' });
    expect(await loadFeed({ unknown: 'x' })).toMatchObject({ status: 'INVALID' });
    expect(await loadFeed({ category: ['a', 'b'] })).toMatchObject({ status: 'INVALID' });
    expect(mocks.feed).not.toHaveBeenCalled();
    mocks.feed.mockRejectedValue(new Error('postgres://secret'));
    const failed = await loadFeed({});
    expect(failed).toEqual({ status: 'UNAVAILABLE' });
  });
});
describe('loadDetail', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  it('is unavailable while the flag is off, invalid for a malformed id and not found for an unlisted one', async () => {
    mocks.available.mockReturnValue(false);
    expect(await loadDetail(id)).toEqual({ status: 'UNAVAILABLE' });
    mocks.available.mockReturnValue(true);
    expect(await loadDetail('nope')).toEqual({ status: 'NOT_FOUND' });
    expect(mocks.detail).not.toHaveBeenCalled();
    mocks.detail.mockRejectedValue(new WorkError('NOT_FOUND'));
    expect(await loadDetail(id)).toEqual({ status: 'NOT_FOUND' });
  });
  it('returns the brief and hides read failures', async () => {
    mocks.detail.mockResolvedValue({ listingId: id });
    expect(await loadDetail(id)).toEqual({ status: 'READY', detail: { listingId: id } });
    mocks.detail.mockRejectedValue(new Error('postgres://secret'));
    expect(await loadDetail(id)).toEqual({ status: 'UNAVAILABLE' });
  });
});
describe('applyMode', () => {
  const brief = (admission: string) => ({ admission }) as never;
  it('offers the form only for application Raids to a signed-in person while applications are open', async () => {
    mocks.user.mockResolvedValue({ id: 'someone' });
    mocks.config.mockReturnValue({ readsAvailable: true, applicationsAvailable: true });
    expect(await applyMode(brief('APPLICATION'))).toBe('FORM');
    expect(await applyMode(brief('INSTANT'))).toBe('NOT_APPLICABLE');
    mocks.config.mockReturnValue({ readsAvailable: true, applicationsAvailable: false });
    expect(await applyMode(brief('APPLICATION'))).toBe('CLOSED');
    mocks.config.mockReturnValue({ readsAvailable: false, applicationsAvailable: true });
    expect(await applyMode(brief('APPLICATION'))).toBe('CLOSED');
    mocks.user.mockResolvedValue(null);
    mocks.config.mockReturnValue({ readsAvailable: true, applicationsAvailable: true });
    expect(await applyMode(brief('APPLICATION'))).toBe('SIGN_IN');
  });
  it('treats a failing session lookup as signed out, never as an error page', async () => {
    mocks.user.mockRejectedValue(new Error('db'));
    mocks.config.mockReturnValue({ readsAvailable: true, applicationsAvailable: true });
    expect(await applyMode(brief('APPLICATION'))).toBe('SIGN_IN');
  });
});
