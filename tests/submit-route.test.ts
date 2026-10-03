import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  raid: vi.fn(),
  rateLimit: vi.fn(),
  publicLimit: vi.fn(),
  user: vi.fn(),
  current: vi.fn(),
  enqueue: vi.fn(),
}));
vi.mock('../src/lib/db', () => ({ db: { raid: { findUnique: mocks.raid } } }));
vi.mock('../src/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/auth')>()),
  checkOrigin: vi.fn(),
  requireUser: mocks.user,
  currentUser: mocks.current,
  rateLimit: mocks.rateLimit,
  publicRateLimit: mocks.publicLimit,
}));
vi.mock('../src/lib/queue', () => ({ enqueue: mocks.enqueue }));
vi.mock('../src/lib/tracking', () => ({ submitTrackingPost: vi.fn() }));
import { HttpError } from '../src/lib/auth';
import { POST } from '../src/app/api/raids/[id]/submit/route';
import { routeContext, routeRequest } from './helpers/route';

const submit = () =>
  POST(
    routeRequest('http://localhost/api/raids/r1/submit', {
      body: { url: 'https://x.com/someone/status/123' },
    }),
    routeContext({ id: 'r1' }),
  );
const legacy = {
  id: 'r1',
  trackingVersion: 1,
  hidden: false,
  status: 'ACTIVE',
  endsAt: new Date(Date.now() + 3600000),
  creator: { suspended: false },
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockRejectedValue(new HttpError(401, 'Sign in to continue.'));
});
it('rejects an anonymous submission to a v2 raid before charging any limit', async () => {
  mocks.raid.mockResolvedValue({ id: 'r1', trackingVersion: 2 });
  expect((await submit()).status).toBe(401);
  expect(mocks.rateLimit).not.toHaveBeenCalled();
  expect(mocks.publicLimit).not.toHaveBeenCalled();
});
it('limits a legacy submission per user when signed in and per client otherwise', async () => {
  mocks.raid.mockResolvedValue(legacy);
  mocks.current.mockResolvedValue({ id: 'u1' });
  expect((await submit()).status).toBe(202);
  expect(mocks.rateLimit).toHaveBeenCalledWith('submit:user:u1', 10, 3600);
  expect(mocks.publicLimit).not.toHaveBeenCalled();
  mocks.current.mockResolvedValue(null);
  expect((await submit()).status).toBe(202);
  expect(mocks.publicLimit).toHaveBeenCalledWith(expect.any(Request), 'submit', 10, 3600, 200);
});
