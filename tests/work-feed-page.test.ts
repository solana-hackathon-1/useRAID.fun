import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  available: vi.fn(),
  feed: vi.fn(),
  detail: vi.fn(),
  user: vi.fn(),
  config: vi.fn(),
  mine: vi.fn(),
  cookie: vi.fn(),
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
  readMyRaidsFromHost: mocks.mine,
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: mocks.cookie }),
}));
import { applyMode, viewerStanding, loadDetail, loadFeed } from '../src/lib/work-feed-page';
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
describe('applyMode for instant-start Raids', () => {
  const instant = { admission: 'INSTANT' } as never;
  it('offers acceptance to a signed-in person only while reads and acceptance are open', async () => {
    mocks.user.mockResolvedValue({ id: 'someone' });
    mocks.config.mockReturnValue({ readsAvailable: true, acceptanceAvailable: true });
    expect(await applyMode(instant)).toBe('ACCEPT');
    mocks.config.mockReturnValue({ readsAvailable: true, acceptanceAvailable: false });
    expect(await applyMode(instant)).toBe('CLOSED');
    mocks.config.mockReturnValue({ readsAvailable: false, acceptanceAvailable: true });
    expect(await applyMode(instant)).toBe('CLOSED');
    mocks.user.mockResolvedValue(null);
    mocks.config.mockReturnValue({ readsAvailable: true, acceptanceAvailable: true });
    expect(await applyMode(instant)).toBe('SIGN_IN');
  });
});
describe('viewerStanding', () => {
  const termsVersionId = '22222222-2222-4222-8222-222222222222';
  const slotId = '11111111-1111-4111-8111-111111111111';
  const otherSlot = '33333333-3333-4333-8333-333333333333';
  const detail = { termsVersionId, openSlotIds: [slotId] } as never;
  const card = (patch: Record<string, unknown>) => ({
    applicationId: 'a',
    slotId,
    termsVersionId,
    title: 't',
    state: 'SUBMITTED',
    offer: {
      offerId: '44444444-4444-4444-8444-444444444444',
      state: 'PENDING',
      expiresAt: 'x',
      expired: false,
    },
    ...patch,
  });
  beforeEach(() => {
    mocks.user.mockResolvedValue({ id: 'someone' });
    mocks.cookie.mockReturnValue({ value: 'session' });
    mocks.config.mockReturnValue({ readsAvailable: true, acceptanceAvailable: true });
  });
  it("returns the viewer's usable offer for these exact terms and an open slot", async () => {
    mocks.mine.mockResolvedValue({ applications: [card({})] });
    expect(await viewerStanding(detail)).toMatchObject({
      offer: { offerId: '44444444-4444-4444-8444-444444444444', slotId },
    });
  });
  it('ignores expired, revoked, other-terms and other-slot offers', async () => {
    mocks.mine.mockResolvedValue({
      applications: [
        card({ offer: { offerId: 'o', state: 'PENDING', expiresAt: 'x', expired: true } }),
        card({ offer: { offerId: 'o', state: 'REVOKED', expiresAt: 'x', expired: false } }),
        card({ termsVersionId: '55555555-5555-4555-8555-555555555555' }),
        card({ slotId: otherSlot }),
        card({ state: 'WITHDRAWN' }),
        card({ offer: null }),
      ],
    });
    expect((await viewerStanding(detail)).offer).toBeNull();
  });
  it('is null while acceptance is closed, signed out, or reads fail, and never throws', async () => {
    mocks.mine.mockResolvedValue({ applications: [card({})] });
    mocks.config.mockReturnValue({ readsAvailable: true, acceptanceAvailable: false });
    expect((await viewerStanding(detail)).offer).toBeNull();
    mocks.config.mockReturnValue({ readsAvailable: true, acceptanceAvailable: true });
    mocks.user.mockResolvedValue(null);
    expect((await viewerStanding(detail)).offer).toBeNull();
    mocks.user.mockResolvedValue({ id: 'someone' });
    mocks.mine.mockRejectedValue(new Error('postgres://secret'));
    expect((await viewerStanding(detail)).offer).toBeNull();
  });
  it("reports the viewer's own submitted application for these terms, without needing acceptance", async () => {
    mocks.config.mockReturnValue({ readsAvailable: true, acceptanceAvailable: false });
    mocks.mine.mockResolvedValue({ applications: [card({ offer: null })] });
    expect(await viewerStanding(detail)).toMatchObject({ applied: true, offer: null });
    mocks.mine.mockResolvedValue({
      applications: [
        card({ state: 'WITHDRAWN', offer: null }),
        card({ termsVersionId: '55555555-5555-4555-8555-555555555555', offer: null }),
      ],
    });
    expect((await viewerStanding(detail)).applied).toBe(false);
  });
  it('spreads applicants over the open slots by a stable per-person choice instead of the first slot', async () => {
    const slots = Array.from({ length: 5 }, (_, i) => `${i}0000000-0000-4000-8000-000000000000`);
    const many = { termsVersionId, openSlotIds: slots } as never;
    mocks.mine.mockResolvedValue({ applications: [] });
    const chosen = new Set<string>();
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) {
      mocks.user.mockResolvedValue({ id });
      const first = (await viewerStanding(many)).applySlotId;
      expect(slots).toContain(first);
      expect((await viewerStanding(many)).applySlotId).toBe(first);
      chosen.add(first);
    }
    expect(chosen.size).toBeGreaterThan(1);
  });
  it('falls back to the first open slot when signed out or reads are off', async () => {
    mocks.user.mockResolvedValue(null);
    expect(await viewerStanding(detail)).toEqual({
      offer: null,
      applied: false,
      applySlotId: slotId,
    });
  });
});
