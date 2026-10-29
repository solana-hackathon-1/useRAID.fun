import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  cookie: vi.fn(),
  config: vi.fn(),
  my: vi.fn(),
  reviews: vi.fn(),
  applicants: vi.fn(),
  active: vi.fn(),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: mocks.cookie }) }));
vi.mock('../src/lib/auth', async (original) => ({
  ...(await original<typeof import('../src/lib/auth')>()),
  currentUser: mocks.user,
}));
vi.mock('../src/lib/work-workspace-host', () => ({
  workWorkspaceConfiguration: mocks.config,
  readMyRaidsFromHost: mocks.my,
  readReviewQueueFromHost: mocks.reviews,
  readApplicantQueueFromHost: mocks.applicants,
  readActiveRaidFromHost: mocks.active,
}));
import { loadActiveRaid, loadMyRaids, loadWorkDesk } from '../src/lib/work-workspace-page';
import { hash } from '../src/lib/auth-primitives';
const flags = {
  readsAvailable: true,
  submissionsAvailable: true,
  reviewsAvailable: false,
  applicationsAvailable: true,
  offersAvailable: false,
};
const mine = {
  version: 'v1',
  capacity: { limit: 1, held: false, engagementId: null, title: null },
  engagements: [],
  applications: [],
};
const queue = { version: 'v1', items: [] };
const applicants = { version: 'v1', listings: [] };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ id: 'synthetic-self' });
  mocks.cookie.mockReturnValue({ value: 'synthetic-cookie' });
  mocks.config.mockReturnValue(flags);
  mocks.my.mockResolvedValue(mine);
  mocks.reviews.mockResolvedValue(queue);
  mocks.applicants.mockResolvedValue(applicants);
});
describe('loadMyRaids', () => {
  it('requires a signed-in session cookie and never reads without one', async () => {
    mocks.user.mockResolvedValue(null);
    expect(await loadMyRaids()).toEqual({ status: 'SIGN_IN' });
    mocks.user.mockResolvedValue({ id: 'u' });
    mocks.cookie.mockReturnValue(undefined);
    expect(await loadMyRaids()).toEqual({ status: 'SIGN_IN' });
    expect(mocks.my).not.toHaveBeenCalled();
  });
  it('reads as the current session and reports write availability', async () => {
    expect(await loadMyRaids()).toEqual({
      status: 'READY',
      view: mine,
      submissionsAvailable: true,
      applicationsAvailable: true,
    });
    expect(mocks.my).toHaveBeenCalledWith({
      accountId: 'synthetic-self',
      sessionHash: hash('synthetic-cookie'),
    });
  });
  it('stays closed when disabled and hides host failure detail', async () => {
    mocks.config.mockReturnValue({ ...flags, readsAvailable: false });
    expect(await loadMyRaids()).toEqual({ status: 'UNAVAILABLE' });
    expect(mocks.my).not.toHaveBeenCalled();
    mocks.config.mockReturnValue(flags);
    mocks.my.mockRejectedValue(new Error('SQL secret detail'));
    expect(await loadMyRaids()).toEqual({ status: 'UNAVAILABLE' });
  });
});
describe('loadWorkDesk', () => {
  it('requires sign-in and an enabled read gate', async () => {
    mocks.user.mockResolvedValue(null);
    expect(await loadWorkDesk()).toEqual({ status: 'SIGN_IN' });
    mocks.user.mockResolvedValue({ id: 'u' });
    mocks.config.mockReturnValue({ ...flags, readsAvailable: false });
    expect(await loadWorkDesk()).toEqual({ status: 'UNAVAILABLE' });
    expect(mocks.reviews).not.toHaveBeenCalled();
    expect(mocks.applicants).not.toHaveBeenCalled();
  });
  it('loads both queues for the current session with per-command availability', async () => {
    expect(await loadWorkDesk()).toEqual({
      status: 'READY',
      reviews: queue,
      applicants,
      reviewsAvailable: false,
      offersAvailable: false,
    });
  });
  it('degrades without detail when either queue fails', async () => {
    mocks.applicants.mockRejectedValue(new Error('SQL secret detail'));
    expect(await loadWorkDesk()).toEqual({ status: 'UNAVAILABLE' });
  });
});
describe('loadActiveRaid (site-wide My Raid indicator)', () => {
  const held = { version: 'v1', engagementId: '00000000-0000-4000-8000-000000000001', title: 'T' };
  it('returns the held Raid for the current session only', async () => {
    mocks.active.mockResolvedValue(held);
    expect(await loadActiveRaid()).toEqual({ engagementId: held.engagementId, title: 'T' });
    expect(mocks.active).toHaveBeenCalledWith({
      accountId: 'synthetic-self',
      sessionHash: hash('synthetic-cookie'),
    });
  });
  it('renders nothing when signed out, flag off, nothing held, or the read fails', async () => {
    mocks.active.mockResolvedValue(held);
    mocks.user.mockResolvedValue(null);
    expect(await loadActiveRaid()).toBeNull();
    mocks.user.mockResolvedValue({ id: 'u' });
    mocks.config.mockReturnValue({ ...flags, readsAvailable: false });
    expect(await loadActiveRaid()).toBeNull();
    expect(mocks.active).not.toHaveBeenCalled();
    mocks.config.mockReturnValue(flags);
    mocks.active.mockResolvedValue(null);
    expect(await loadActiveRaid()).toBeNull();
    mocks.active.mockRejectedValue(new Error('SQL secret detail'));
    expect(await loadActiveRaid()).toBeNull();
  });
});
