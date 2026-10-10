import { beforeEach, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { HttpError } from '../src/lib/auth-primitives';
import { fixtureAddress } from './helpers/wallet-link-fixtures';
const mocks = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock('../src/lib/command-receipts-adapter', () => ({
  runCommandTransaction: mocks.transaction,
}));
import { verifyWalletChallenge } from '../src/lib/wallet-auth';
const verify = () =>
  verifyWalletChallenge('synthetic-digest', bs58.encode(new Uint8Array(64)), fixtureAddress(121));
beforeEach(() => {
  mocks.transaction.mockReset();
});
it.each([
  { code: 'P2002', message: 'private address/owner' },
  { code: 'P2010', meta: { code: '23505', message: 'private address/owner' } },
])('translates unique conflicts without driver text %j', async (error) => {
  mocks.transaction.mockRejectedValue(error);
  await expect(verify()).rejects.toMatchObject({
    status: 409,
    message: 'Wallet belongs to another account.',
  });
});
it('unknown driver failure is sanitized before the shared HTTP/logger boundary', async () => {
  mocks.transaction.mockRejectedValue(Error('private proof/session/owner/driver detail'));
  await expect(verify()).rejects.toMatchObject({
    status: 503,
    message: 'Wallet sign-in unavailable. Please try again.',
  });
});
it('preserves the host’s intentional permission rejection', async () => {
  const error = new HttpError(403, 'This account is suspended.');
  mocks.transaction.mockRejectedValue(error);
  await expect(verify()).rejects.toBe(error);
});
