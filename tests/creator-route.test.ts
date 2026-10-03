import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  update: vi.fn(),
  rateLimit: vi.fn(),
  user: vi.fn(),
}));
vi.mock('../src/lib/db', () => ({
  db: { xAccount: { findUnique: mocks.account }, user: { update: mocks.update } },
}));
vi.mock('../src/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/auth')>()),
  checkOrigin: vi.fn(),
  requireUser: mocks.user,
  rateLimit: mocks.rateLimit,
}));
import { HttpError } from '../src/lib/auth';
import { POST } from '../src/app/api/creator/route';
import { routeRequest } from './helpers/route';

const request = (affiliation: unknown = 'Founder of Example, official site example.com') =>
  POST(routeRequest('http://localhost/api/creator', { body: { affiliation } }));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ id: 'u1', approved: false, suspended: false });
  mocks.account.mockResolvedValue({ id: 'x1' });
});
it('stores an affiliation request for an unapproved creator with an X account', async () => {
  const response = await request();
  expect(response.status).toBe(200);
  expect(mocks.rateLimit).toHaveBeenCalledWith('creator-request:u1', 5, 3600);
  expect(mocks.update).toHaveBeenCalledWith({
    where: { id: 'u1' },
    data: { affiliation: 'Founder of Example, official site example.com' },
  });
});
it('rate limits requests before touching the database', async () => {
  mocks.rateLimit.mockRejectedValue(new HttpError(429, 'Too many requests. Try again later.'));
  expect((await request()).status).toBe(429);
  expect(mocks.update).not.toHaveBeenCalled();
});
it('rejects suspended users, approved users and users without an X account', async () => {
  mocks.user.mockResolvedValue({ id: 'u1', approved: false, suspended: true });
  expect((await request()).status).toBe(403);
  mocks.user.mockResolvedValue({ id: 'u1', approved: true, suspended: false });
  expect((await request()).status).toBe(409);
  mocks.user.mockResolvedValue({ id: 'u1', approved: false, suspended: false });
  mocks.account.mockResolvedValue(null);
  expect((await request()).status).toBe(403);
  expect(mocks.update).not.toHaveBeenCalled();
});
it('validates the affiliation text', async () => {
  expect((await request('too short')).status).toBe(400);
  expect((await request('x'.repeat(1001))).status).toBe(400);
  expect(mocks.update).not.toHaveBeenCalled();
});
