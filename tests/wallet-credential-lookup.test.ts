import { describe, expect, it, vi } from 'vitest';
import {
  IdentityLinkError,
  lookupWalletLink,
  type IdentityTransaction,
} from '../src/identity-link';
import { fixtureAddress } from './helpers/wallet-link-fixtures';
const address = fixtureAddress(120);
function host(
  options: {
    status?: string;
    suspended?: boolean;
    owner?: string;
    finalOwner?: string;
    unavailable?: boolean;
    absent?: boolean;
    malformed?: boolean;
  } = {},
) {
  const query = vi.fn(async (sql: string) => {
    if (options.unavailable) throw Error('private driver proof/token/owner');
    if (sql.includes('pg_advisory_xact_lock')) return [{ locked: 1 }];
    if (sql.includes('FROM "User"'))
      return [{ id: options.owner ?? 'synthetic-owner', suspended: options.suspended ?? false }];
    if (sql.includes('FOR SHARE'))
      return [
        {
          accountId: options.finalOwner ?? options.owner ?? 'synthetic-owner',
          networkIdentity: 'mainnet',
          status: options.status ?? 'ACTIVE',
        },
      ];
    return options.absent
      ? []
      : options.malformed
        ? [{ accountId: null }]
        : [{ accountId: options.owner ?? 'synthetic-owner' }];
  });
  const port: IdentityTransaction = {
    dialect: 'POSTGRESQL',
    isolation: 'READ_COMMITTED',
    query: query as IdentityTransaction['query'],
  };
  return { query, port };
}
describe('replaceable linked-credential lookup', () => {
  it.each(['ACTIVE', 'REVOKED'] as const)(
    'returns an honest %s reservation without granting authentication',
    async (status) => {
      const h = host({ status });
      expect(await lookupWalletLink(h.port, address)).toEqual({
        accountId: 'synthetic-owner',
        networkIdentity: 'mainnet',
        status,
        accountSuspended: false,
      });
    },
  );
  it('retains restriction so the proof/session host can refuse a suspended account', async () => {
    expect(await lookupWalletLink(host({ suspended: true }).port, address)).toMatchObject({
      accountSuspended: true,
    });
  });
  it('returns null for an unreserved address (legacy primary/new-wallet host path)', async () => {
    const h = host({ absent: true });
    expect(await lookupWalletLink(h.port, address)).toBeNull();
    expect(h.query.mock.calls.some(([sql]) => sql.includes('FROM "User"'))).toBe(false);
  });
  it('takes subject/account/link locks in contract order', async () => {
    const h = host();
    await lookupWalletLink(h.port, address);
    const sql = h.query.mock.calls.map(([sql]) => sql);
    expect(sql[0]).toContain('pg_advisory_xact_lock');
    expect(sql[2]).toContain('FOR NO KEY UPDATE');
    expect(sql[3]).toContain('FOR SHARE');
  });
  it.each(['', 'not-a-wallet'])('rejects malformed address %s before SQL', async (value) => {
    const h = host();
    await expect(lookupWalletLink(h.port, value)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(h.query).not.toHaveBeenCalled();
  });
  it('refuses a host without the declared isolation contract', async () => {
    const h = host();
    await expect(
      lookupWalletLink(
        { ...h.port, isolation: 'SERIALIZABLE' } as unknown as IdentityTransaction,
        address,
      ),
    ).rejects.toMatchObject({ code: 'STORAGE_CONTRACT' });
    expect(h.query).not.toHaveBeenCalled();
  });
  it.each([{ malformed: true }, { status: 'UNKNOWN' }, { finalOwner: 'foreign-owner' }])(
    'fails closed for malformed or changed ownership %j',
    async (options) => {
      await expect(lookupWalletLink(host(options).port, address)).rejects.toMatchObject({
        code: 'STORAGE_CONTRACT',
      });
    },
  );
  it('sanitizes unknown driver exceptions', async () => {
    await expect(lookupWalletLink(host({ unavailable: true }).port, address)).rejects.toEqual(
      new IdentityLinkError('STORAGE_UNAVAILABLE'),
    );
  });
});
