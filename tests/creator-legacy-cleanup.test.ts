import type { OAuthAttempt } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => {
  const user = { id: 'creator', xId: '123', handle: 'creator', role: 'CREATOR', suspended: false };
  const tx = {
    user: {
      findUnique: vi.fn(),
      upsert: vi.fn().mockResolvedValue(user),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue(user),
    },
    oAuthAttempt: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    xAccount: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
    session: { findUnique: vi.fn(), deleteMany: vi.fn(), create: vi.fn() },
    walletIdentity: { upsert: vi.fn() },
    settings: { upsert: vi.fn() },
    balanceEntry: { findFirst: vi.fn().mockResolvedValue({ id: 'existing-test-credit' }) },
  };
  return { tx, user };
});
vi.mock('../src/lib/db', () => ({
  db: { ...host.tx, $transaction: async (run: (tx: typeof host.tx) => unknown) => run(host.tx) },
}));
vi.mock('../src/lib/account-merge', () => ({
  lockIdentity: vi.fn(),
  isEmptyAccount: vi.fn(),
  absorbAccount: vi.fn(),
}));
vi.mock('../src/lib/usdc', () => ({ studioSandbox: () => true, lockBalance: vi.fn() }));
import { completeConnection } from '../src/lib/x-oauth';
import { sandboxUser } from '../src/lib/studio-sandbox';

beforeEach(() => {
  vi.clearAllMocks();
  host.tx.user.findUnique.mockResolvedValue(null);
  vi.stubEnv('ADMIN_X_IDS', '');
  vi.stubEnv('X_ADMIN_USER_ID', '');
  // Old installations may still supply this retired setting; it must have no effect.
  vi.stubEnv('LOCAL_AUTO_APPROVE_CREATORS', 'true');
});
afterEach(() => vi.unstubAllEnvs());

describe('retired creator metadata is not authentication authority', () => {
  it.each([false, true])(
    'X sign-in writes identity/role, not approval (admin=%s)',
    async (admin) => {
      if (admin) vi.stubEnv('ADMIN_X_IDS', '123');
      await completeConnection(
        { stateHash: 'claimed-state', userId: null, sessionHash: null } as OAuthAttempt,
        { id: '123', username: 'creator', name: 'Creator' },
      );
      const data = host.tx.user.upsert.mock.calls[0][0];
      expect(data.create).toEqual({
        xId: '123',
        handle: 'creator',
        role: admin ? 'ADMIN' : 'CREATOR',
      });
      expect(data.update).toEqual(
        admin ? { handle: 'creator', role: 'ADMIN' } : { handle: 'creator' },
      );
      expect(host.tx.session.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ userId: 'creator', via: 'x' }),
      });
    },
  );
  it('demotes an existing administrator without rewriting retired fields', async () => {
    host.tx.user.findUnique.mockResolvedValue({ ...host.user, role: 'ADMIN', approved: true });
    await completeConnection(
      { stateHash: 'claimed-state', userId: null, sessionHash: null } as OAuthAttempt,
      { id: '123', username: 'creator', name: 'Creator' },
    );
    expect(host.tx.user.upsert.mock.calls[0][0].update).toEqual({
      handle: 'creator',
      role: 'CREATOR',
    });
  });
  it.each(['new-creator', 'unapproved-old-fixture'])(
    'sandbox login ignores retired fixture prefixes: %s',
    async (id) => {
      await sandboxUser(id);
      const data = host.tx.user.upsert.mock.calls[0][0];
      expect(data.create).toEqual({
        xId: `studio-test-${id}`,
        handle: 'test_creator',
        role: 'ADMIN',
      });
      expect(data.update).toEqual({});
      expect(host.tx.walletIdentity.upsert).toHaveBeenCalledOnce();
      expect(host.tx.xAccount.upsert).toHaveBeenCalledOnce();
    },
  );
});
