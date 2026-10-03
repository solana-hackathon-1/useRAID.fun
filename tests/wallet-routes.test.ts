import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rateLimit: vi.fn(), challenge: vi.fn(), verify: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('../src/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/auth')>()),
  checkOrigin: vi.fn(),
  publicRateLimit: mocks.rateLimit,
  currentUser: async () => null,
}));
vi.mock('../src/lib/wallet-auth', () => ({
  createWalletChallenge: mocks.challenge,
  verifyWalletChallenge: mocks.verify,
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
    expect(mocks.challenge).toHaveBeenCalledWith('abc');
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
    expect(mocks.verify).toHaveBeenCalledWith(digest, 's', 'a', undefined);
  });
});
