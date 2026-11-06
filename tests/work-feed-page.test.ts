import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  available: vi.fn(),
  rewardFilter: vi.fn(),
  assets: vi.fn(),
  facets: vi.fn(),
  feed: vi.fn(),
  detail: vi.fn(),
  user: vi.fn(),
  config: vi.fn(),
  mine: vi.fn(),
  cookie: vi.fn(),
}));
vi.mock('../src/lib/work-feed-host', () => ({
  workFeedAvailable: mocks.available,
  workFeedEligibilityAvailable: () => false,
  workFeedRewardFilterAvailable: mocks.rewardFilter,
  readFeedAssetsFromHost: mocks.assets,
  readFeedFacetsFromHost: mocks.facets,
  readFeedForViewerFromHost: vi.fn(),
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
  mocks.rewardFilter.mockReturnValue(false);
  mocks.facets.mockResolvedValue({ categories: [], skills: [] });
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
describe('loadFeed: deadline window and suggested categories and skills (T097)', () => {
  it('maps both apply-by dates to UTC instants and reads them as one typed window', async () => {
    const loaded = await loadFeed({ closesAfter: '2026-11-03', closesBefore: '2026-11-10' });
    expect(loaded).toMatchObject({ status: 'READY' });
    expect(mocks.feed).toHaveBeenCalledWith({
      closesAfter: '2026-11-03T00:00:00.000Z',
      closesBefore: '2026-11-10T00:00:00.000Z',
      sort: 'newest',
      limit: 20,
    });
  });
  it('refuses an inverted or empty window and a malformed date without reading', async () => {
    for (const params of [
      { closesAfter: '2026-11-10', closesBefore: '2026-11-03' },
      { closesAfter: '2026-11-10', closesBefore: '2026-11-10' },
      { closesAfter: 'tomorrow' },
      { visibility: 'PUBLIC' },
      { visibility: 'INVITE_ONLY' },
    ])
      expect(await loadFeed(params)).toMatchObject({ status: 'INVALID' });
    expect(mocks.feed).not.toHaveBeenCalled();
  });
  it('hands the form the live categories and skills, and still lists Raids if suggestions fail', async () => {
    mocks.facets.mockResolvedValue({ categories: ['design'], skills: ['figma'] });
    expect(await loadFeed({})).toMatchObject({
      status: 'READY',
      facets: { categories: ['design'], skills: ['figma'] },
    });
    mocks.facets.mockRejectedValue(new Error('postgres://secret'));
    expect(await loadFeed({})).toMatchObject({
      status: 'READY',
      page,
      facets: { categories: [], skills: [] },
    });
  });
});
describe('loadFeed: display-unit minimum reward within one asset (T097)', () => {
  const sol = { chain: 'SOLANA', networkIdentity: 'synthetic-work', kind: 'NATIVE_SOL' } as const;
  const solKey = '["SOLANA","synthetic-work","NATIVE_SOL"]';
  const token = {
    chain: 'SOLANA',
    networkIdentity: 'synthetic-work',
    kind: 'TOKEN',
    mint: 'So11111111111111111111111111111111111111112',
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  } as const;
  const tokenKey = `["SOLANA","synthetic-work","TOKEN","${token.mint}","${token.tokenProgram}"]`;
  const assets = [
    { assetKey: solKey, assetId: sol, decimals: 9 },
    { assetKey: tokenKey, assetId: token, decimals: 6 },
  ];
  beforeEach(() => {
    mocks.assets.mockResolvedValue(assets);
  });
  it('refuses a minimum without reading while its feature flag is off, and reports the control closed', async () => {
    for (const params of [
      { assetKey: solKey, minRewardAmount: '1.5' },
      { assetKey: solKey, minReward: '600' },
    ])
      expect(await loadFeed(params)).toMatchObject({ status: 'INVALID' });
    expect(mocks.feed).not.toHaveBeenCalled();
    expect(mocks.assets).not.toHaveBeenCalled();
    expect(await loadFeed({ assetKey: solKey })).toMatchObject({
      status: 'READY',
      reward: { enabled: false, assets: [], amount: '', problem: null },
    });
  });
  it('converts the typed display amount with the selected asset decimals before the read', async () => {
    mocks.rewardFilter.mockReturnValue(true);
    const loaded = await loadFeed({ assetKey: solKey, minRewardAmount: '1.5' });
    expect(loaded).toMatchObject({
      status: 'READY',
      reward: { enabled: true, assets, amount: '1.5', problem: null },
    });
    expect(mocks.feed).toHaveBeenCalledWith({
      assetKey: solKey,
      minReward: '1500000000',
      sort: 'newest',
      limit: 20,
    });
  });
  it('scopes the same typed amount to each asset, never carrying a quantity across assets', async () => {
    mocks.rewardFilter.mockReturnValue(true);
    await loadFeed({ assetKey: tokenKey, minRewardAmount: '1.5' });
    expect(mocks.feed).toHaveBeenLastCalledWith(
      expect.objectContaining({ assetKey: tokenKey, minReward: '1500000' }),
    );
  });
  it('shows the form with an actionable problem and does not read when the amount cannot be converted', async () => {
    mocks.rewardFilter.mockReturnValue(true);
    const cases: [Record<string, string>, string][] = [
      [{ minRewardAmount: '1.5' }, 'reward asset'],
      [{ assetKey: solKey, minRewardAmount: '0.0000000001' }, '9 decimal places'],
      [{ assetKey: tokenKey, minRewardAmount: '-1' }, 'cannot be negative'],
      [{ assetKey: tokenKey, minRewardAmount: '   ' }, 'clear the field'],
      [{ assetKey: tokenKey, minRewardAmount: '99999999999999999999' }, 'more than'],
      [{ assetKey: tokenKey, minRewardAmount: '1,5' }, 'period'],
      [{ assetKey: 'some-other-asset', minRewardAmount: '1' }, 'not confirmed'],
    ];
    for (const [params, text] of cases) {
      const loaded = await loadFeed(params);
      expect(loaded, JSON.stringify(params)).toMatchObject({
        status: 'READY',
        page: { items: [], nextCursor: null },
        reward: { enabled: true, amount: params.minRewardAmount },
      });
      expect(loaded.status === 'READY' && loaded.reward.problem, JSON.stringify(params)).toContain(
        text,
      );
    }
    expect(mocks.feed).not.toHaveBeenCalled();
  });
  it('never accepts the API base-unit parameter on the page, even with the flag on', async () => {
    mocks.rewardFilter.mockReturnValue(true);
    expect(await loadFeed({ assetKey: solKey, minReward: '600' })).toMatchObject({
      status: 'INVALID',
    });
    expect(await loadFeed({ assetKey: solKey, minRewardAmount: ['1', '2'] })).toMatchObject({
      status: 'INVALID',
    });
    expect(mocks.feed).not.toHaveBeenCalled();
  });
  it('treats an empty field as no minimum and keeps the plain asset filter', async () => {
    mocks.rewardFilter.mockReturnValue(true);
    await loadFeed({ assetKey: solKey, minRewardAmount: '' });
    expect(mocks.feed).toHaveBeenCalledWith({ assetKey: solKey, sort: 'newest', limit: 20 });
  });
  it('is unavailable, not silently unfiltered, when the asset list cannot be read', async () => {
    mocks.rewardFilter.mockReturnValue(true);
    mocks.assets.mockRejectedValue(new Error('down'));
    expect(await loadFeed({ assetKey: solKey, minRewardAmount: '1' })).toEqual({
      status: 'UNAVAILABLE',
    });
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
