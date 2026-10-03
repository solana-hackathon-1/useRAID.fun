import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(),
  challenge: vi.fn(),
  verify: vi.fn(),
  rotate: vi.fn(),
  user: vi.fn(),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('../src/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/auth')>()),
  checkOrigin: vi.fn(),
  publicRateLimit: mocks.rateLimit,
  currentUser: () => mocks.user(),
}));
vi.mock('../src/lib/wallet-auth', () => ({
  createWalletChallenge: mocks.challenge,
  verifyWalletChallenge: mocks.verify,
  rotateWallet: mocks.rotate,
}));
import { POST as challenge } from '../src/app/api/wallet/challenge/route';
import { POST as verify } from '../src/app/api/wallet/verify/route';
import { routeRequest } from './helpers/route';

const post = (handler: (request: Request) => Promise<Response>, body: unknown, rawBody?: string) =>
  handler(routeRequest('http://localhost/api/wallet/x', { method: 'POST', body, rawBody }));
const digest = 'a'.repeat(64);
beforeEach(() => {
  mocks.rateLimit.mockReset();
  mocks.challenge.mockReset().mockResolvedValue({ digest, message: 'm' });
  mocks.verify.mockReset().mockResolvedValue('token');
  mocks.rotate.mockReset().mockResolvedValue(undefined);
  mocks.user.mockReset().mockResolvedValue(null);
});

describe('wallet routes input handling', () => {
  it.each([null, [], 'x'])('challenge rejects body %j with 400', async (body) => {
    expect((await post(challenge, body, JSON.stringify(body))).status).toBe(400);
    expect(mocks.challenge).not.toHaveBeenCalled();
  });
  it('challenge rejects malformed JSON and a missing address with 400', async () => {
    expect((await post(challenge, undefined, '{bad')).status).toBe(400);
    expect((await post(challenge, {})).status).toBe(400);
  });
  it('challenge passes a valid address through', async () => {
    expect((await post(challenge, { address: 'abc' })).status).toBe(200);
    expect(mocks.challenge).toHaveBeenCalledWith('abc', undefined, undefined);
  });
  it.each([null, {}, { digest: 'short', address: 'a', signature: 's' }])(
    'verify rejects %j with 400',
    async (body) => {
      expect((await post(verify, body, JSON.stringify(body))).status).toBe(400);
      expect(mocks.verify).not.toHaveBeenCalled();
    },
  );
  it('verify accepts a well-formed body', async () => {
    const res = await post(verify, { digest, address: 'a', signature: 's' });
    expect(res.status).toBe(200);
    expect(mocks.verify).toHaveBeenCalledWith(digest, 's', 'a', undefined, undefined);
  });
  it('binds the challenge to the signed-in user and requires one to rotate', async () => {
    mocks.user.mockResolvedValue({ id: 'u1' });
    await post(challenge, { address: 'abc' });
    expect(mocks.challenge).toHaveBeenLastCalledWith('abc', 'u1', undefined);
    await post(challenge, { address: 'abc', rotate: true });
    expect(mocks.challenge).toHaveBeenLastCalledWith('abc', 'u1', 'rotate');
    mocks.user.mockResolvedValue(null);
    mocks.challenge.mockClear();
    expect((await post(challenge, { address: 'abc', rotate: true })).status).toBe(401);
    expect(mocks.challenge).not.toHaveBeenCalled();
  });
  it('rotates the wallet of the signed-in user without issuing a session', async () => {
    const body = { digest, address: 'a', signature: 's', rotate: true };
    expect((await post(verify, body)).status).toBe(401);
    mocks.user.mockResolvedValue({ id: 'u1' });
    const res = await post(verify, body);
    expect(res.status).toBe(200);
    expect(mocks.rotate).toHaveBeenCalledWith('u1', digest, 's', 'a');
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});
