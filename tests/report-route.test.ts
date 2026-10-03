import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  limit: vi.fn(),
  raid: vi.fn(),
  tracking: vi.fn(),
  funding: vi.fn(),
}));
vi.mock('../src/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/auth')>()),
  publicRateLimit: mocks.limit,
}));
vi.mock('../src/lib/data', () => ({ getRaid: mocks.raid }));
vi.mock('../src/lib/tracking-view', () => ({ trackingView: mocks.tracking }));
vi.mock('../src/lib/db', () => ({ db: { raid: { findUnique: mocks.funding } } }));
import { GET } from '../src/app/api/raids/[id]/report/route';
import { config } from '../src/lib/config';
import { HttpError } from '../src/lib/auth';
import { routeContext, routeRequest } from './helpers/route';

const view = (patch: Record<string, unknown> = {}) => ({
  health: 'fresh',
  phase: 'COLLECTING',
  resultVersion: null,
  impressions: { total: 5000, missing: 0 },
  impressionTarget: 10000,
  targetReachedAt: null,
  leaderboard: [{ handle: 'a', score: 1, qualifiedPosts: 4, scoredPostIds: ['1'] }],
  topPosts: [],
  ...patch,
});
const cpa = async (response: Response) =>
  (await response.text())
    .split('\r\n')
    .find((line) => line.startsWith('"Content CPA (SOL per qualifying post)"'))!
    .split('","')[1]
    .replace(/"$/, '');
const get = () =>
  GET(routeRequest('http://localhost:3000/api/raids/r1/report'), routeContext({ id: 'r1' }));
beforeEach(() => {
  config.demo = false;
  mocks.limit.mockReset().mockResolvedValue(undefined);
  mocks.raid.mockReset().mockResolvedValue({
    id: 'r1',
    title: 'Report',
    name: 'N',
    mint: null,
    status: 'ACTIVE',
    startsAt: '',
    endsAt: '',
    freshness: 'fresh',
    trackingVersion: 2,
    score: 0,
    raiders: 1,
    posts: 4,
    interactions: 0,
  });
  mocks.funding
    .mockReset()
    .mockResolvedValue({ fundingLamports: 2_000_000_000n, fundingAsset: 'SOL', poolUnits: null });
});
describe('campaign report', () => {
  it('is throttled before any data is read', async () => {
    expect((await get()).status).toBe(200);
    expect(mocks.limit).toHaveBeenCalledWith(expect.any(Request), 'report', 20, 600, 300);
    mocks.limit.mockRejectedValueOnce(new HttpError(429, 'Too many requests. Try again later.'));
    mocks.raid.mockClear();
    expect((await get()).status).toBe(429);
    expect(mocks.raid).not.toHaveBeenCalled();
  });
  it('shows no SOL CPA before results are reviewed', async () => {
    mocks.tracking.mockResolvedValue(view());
    expect(await cpa(await get())).toBe(
      'Unavailable — requires reviewed results and complete views',
    );
    mocks.tracking.mockResolvedValue(view({ phase: 'REVIEW', resultVersion: 1 }));
    expect(await cpa(await get())).toMatch(/^Unavailable/);
  });
  it('shows no SOL CPA while views are missing', async () => {
    mocks.tracking.mockResolvedValue(
      view({ phase: 'APPROVED', resultVersion: 1, impressions: { total: 5000, missing: 2 } }),
    );
    expect(await cpa(await get())).toMatch(/^Unavailable/);
  });
  it('computes the SOL CPA from an approved, fully measured result', async () => {
    mocks.tracking.mockResolvedValue(view({ phase: 'APPROVED', resultVersion: 1 }));
    expect(await cpa(await get())).toBe('0.25000000');
  });
});
