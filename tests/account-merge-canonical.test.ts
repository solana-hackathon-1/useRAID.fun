// Proposed compatibility behavior. Until reviewed implementation, this suite is an
// explicit RED checkpoint, run separately from the unchanged product test suite.
// Promote the same assertions into tests/ with the GREEN implementation.
import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { absorbAccount, isEmptyAccount } from '../src/lib/account-merge';

const legacyCategories = [
  'raid',
  'tokenLaunch',
  'rewardEnrollment',
  'raidEnrollment',
  'balanceEntry',
  'usdcTransfer',
  'usdcAllocation',
] as const;

function observedTransaction(
  options: {
    mapped?: boolean;
    category?: (typeof legacyCategories)[number];
    role?: string;
    suspended?: boolean;
    missing?: boolean;
  } = {},
) {
  const keep = {
    id: 'keeper',
    role: 'CREATOR',
    suspended: false,
    xId: null,
    approved: false,
    affiliation: '',
  };
  const drop = {
    id: 'protected',
    role: options.role ?? 'CREATOR',
    suspended: options.suspended ?? false,
    xId: null,
    approved: false,
    affiliation: '',
  };
  const mutations = {
    accountDelete: vi.fn().mockResolvedValue(drop),
    accountUpdate: vi.fn().mockResolvedValue(keep),
    sessionDelete: vi.fn().mockResolvedValue({ count: 0 }),
    attemptDelete: vi.fn().mockResolvedValue({ count: 0 }),
    mergeEvent: vi.fn().mockResolvedValue({ id: 'event' }),
  };
  const transaction = {
    user: {
      findUnique: vi.fn().mockResolvedValue(options.missing ? null : drop),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === keep.id ? keep : drop,
      ),
      delete: mutations.accountDelete,
      update: mutations.accountUpdate,
    },
    ...Object.fromEntries(
      legacyCategories.map((name) => [
        name,
        { count: vi.fn().mockResolvedValue(options.category === name ? 1 : 0) },
      ]),
    ),
    // This is a trusted synthetic future-reference observation, not a persisted row.
    // Both ORM and parameterized host forms expose the same planned fact.
    participant: { count: vi.fn().mockResolvedValue(options.mapped ? 1 : 0) },
    $queryRawUnsafe: vi.fn(async (sql: string) =>
      sql === 'SHOW transaction_isolation'
        ? [{ transaction_isolation: 'read committed' }]
        : [{ present: options.mapped ?? false }],
    ),
    // The leading User-row lock is a read lock, not a mutation (identity lock order, N1).
    $queryRaw: vi.fn().mockResolvedValue([]),
    walletIdentity: { findUnique: vi.fn().mockResolvedValue(null) },
    oAuthAttempt: { deleteMany: mutations.attemptDelete },
    session: { deleteMany: mutations.sessionDelete },
    moderationEvent: { create: mutations.mergeEvent },
  };
  return { transaction: transaction as unknown as Prisma.TransactionClient, mutations };
}

describe('T006 planned canonical references protect legacy absorption decisions', () => {
  it('keeps the existing genuinely empty account result', async () => {
    const { transaction } = observedTransaction();
    expect(await isEmptyAccount(transaction, 'protected')).toBe(true);
  });
  it('a canonical HUMAN mapping makes an otherwise legacy-empty account nonempty', async () => {
    const { transaction } = observedTransaction({ mapped: true });
    expect(await isEmptyAccount(transaction, 'protected')).toBe(false);
  });
  it.each(legacyCategories)(
    'retains nonempty protection for legacy %s references',
    async (category) => {
      const { transaction } = observedTransaction({ category });
      expect(await isEmptyAccount(transaction, 'protected')).toBe(false);
    },
  );
  it.each([{ role: 'ADMIN' }, { suspended: true }, { missing: true }])(
    'retains existing role, restriction and missing-account denials: %j',
    async (options) => {
      const { transaction } = observedTransaction(options);
      expect(await isEmptyAccount(transaction, 'protected')).toBe(false);
    },
  );
  it('refuses mapped-account absorption before any credential/session/account/event mutation', async () => {
    const { transaction, mutations } = observedTransaction({ mapped: true });
    await expect(absorbAccount(transaction, 'keeper', 'protected')).rejects.toThrow(
      'Only an activity-free account can be merged.',
    );
    for (const mutation of Object.values(mutations)) expect(mutation).not.toHaveBeenCalled();
  });
});
