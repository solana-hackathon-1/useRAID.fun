import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  rateLimit: vi.fn(),
  charge: vi.fn(),
  previews: vi.fn(),
}));
vi.mock('../src/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/auth')>()),
  requireUser: mocks.user,
  rateLimit: mocks.rateLimit,
}));
vi.mock('../src/lib/studio-targets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/studio-targets')>()),
  chargeStudioLookups: mocks.charge,
  targetPreviews: mocks.previews,
}));
import { HttpError } from '../src/lib/auth';
import { GET } from '../src/app/api/studio/preview/route';
import { routeRequest } from './helpers/route';

const preview = () =>
  GET(
    routeRequest(
      'http://localhost/api/studio/preview?type=post&url=https://x.com/a/status/123456789',
    ),
  );
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ id: 'u1', approved: true });
  mocks.previews.mockResolvedValue([{ id: '123456789' }]);
});
it('requires creator approval before any X lookup', async () => {
  mocks.user.mockResolvedValue({ id: 'u1', approved: false });
  expect((await preview()).status).toBe(403);
  expect(mocks.charge).not.toHaveBeenCalled();
  expect(mocks.previews).not.toHaveBeenCalled();
});
it('charges the daily lookup quota and stops when it is spent', async () => {
  expect((await preview()).status).toBe(200);
  expect(mocks.charge).toHaveBeenCalledWith('u1', 1);
  mocks.charge.mockRejectedValue(new HttpError(429, 'Too many requests. Try again later.'));
  expect((await preview()).status).toBe(429);
  expect(mocks.previews).toHaveBeenCalledTimes(1);
});
