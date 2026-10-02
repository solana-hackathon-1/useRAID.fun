import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ deleteMany: vi.fn(), cookie: undefined as string | undefined }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (mocks.cookie ? { value: mocks.cookie } : undefined),
    delete: vi.fn(),
  }),
}));
vi.mock('../src/lib/db', () => ({ db: { session: { deleteMany: mocks.deleteMany } } }));
import { POST } from '../src/app/api/auth/[action]/route';
import { config } from '../src/lib/config';
import { routeContext, routeRequest } from './helpers/route';

const call = (action: string, origin?: string) =>
  POST(
    routeRequest('http://localhost/api/auth/' + action, { method: 'POST', origin }),
    routeContext({ action }),
  );
beforeEach(() => {
  mocks.deleteMany.mockReset().mockResolvedValue({ count: 1 });
  mocks.cookie = 'token';
  config.demo = false;
});

describe('POST /api/auth/[action]', () => {
  it('rejects a wrong origin with 403', async () => {
    expect((await call('logout', 'https://evil.example')).status).toBe(403);
  });
  it('returns 404 for an unknown action', async () => {
    expect((await call('nope', new URL(config.appUrl).origin)).status).toBe(404);
  });
  it('logs out', async () => {
    expect((await call('logout', new URL(config.appUrl).origin)).status).toBe(200);
    expect(mocks.deleteMany).toHaveBeenCalled();
  });
  it('reports database failures as 503 instead of 403', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.deleteMany.mockRejectedValue(new Error('db down'));
    expect((await call('logout', new URL(config.appUrl).origin)).status).toBe(503);
  });
});
