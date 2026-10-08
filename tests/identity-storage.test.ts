import { describe, expect, it, vi } from 'vitest';
import {
  ensureHumanParticipant,
  findHumanParticipant,
  hasHumanParticipant,
  type IdentityTransaction,
} from '../src/identity-storage';
import {
  classifyIdentityStorageFailure,
  createPrismaIdentityTransaction,
} from '../src/lib/identity-storage-adapter';
import type { Prisma } from '@prisma/client';

const human = { id: 'd4bbeef1-55a8-4d8e-8d03-f3b012f92401', kind: 'HUMAN', accountId: 'alice' };
const input = { accountId: 'alice', actorAccountId: 'alice', requestId: 'request-1' };
function port(...rows: unknown[][]) {
  const query = vi.fn().mockImplementation(async () => rows.shift() ?? []);
  const tx: IdentityTransaction = { dialect: 'POSTGRESQL', isolation: 'READ_COMMITTED', query };
  return { tx, query };
}
describe('bounded HUMAN storage v1', () => {
  it('provisions against an existing account, binds values and returns the shared DTO', async () => {
    const { tx, query } = port([{ id: 'alice' }], [human]);
    expect(await ensureHumanParticipant(tx, input)).toEqual(human);
    expect(query.mock.calls[0][0]).toContain('FOR KEY SHARE');
    expect(query.mock.calls[0][1]).toEqual(['alice']);
    expect(query.mock.calls[1][0]).toContain('ON CONFLICT');
    expect(query.mock.calls[1][1]).toEqual(['alice', 'alice', 'request-1']);
    expect(query.mock.calls.every(([sql]) => !sql.includes('alice'))).toBe(true);
  });
  it('reads the winner separately after a conflicting insert without rewriting provenance', async () => {
    const { tx, query } = port([{ id: 'alice' }], [], [human]);
    expect(await ensureHumanParticipant(tx, input)).toEqual(human);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[1][0]).toContain('DO NOTHING');
    expect(query.mock.calls[2][0]).toContain('SELECT');
  });
  it.each(['', ' space', 'x'.repeat(201), "alice'; DELETE"])(
    'denies malformed identifiers before SQL: %s',
    async (id) => {
      for (const field of ['accountId', 'actorAccountId', 'requestId']) {
        const { tx, query } = port();
        await expect(ensureHumanParticipant(tx, { ...input, [field]: id })).rejects.toMatchObject({
          code: 'INVALID_INPUT',
        });
        expect(query).not.toHaveBeenCalled();
      }
    },
  );
  it('denies wrong-account actor before SQL', async () => {
    const { tx, query } = port();
    await expect(
      ensureHumanParticipant(tx, { ...input, actorAccountId: 'mallory' }),
    ).rejects.toMatchObject({ code: 'WRONG_ACTOR' });
    expect(query).not.toHaveBeenCalled();
  });
  it.each(['SERIALIZABLE', 'REPEATABLE_READ', 'UNKNOWN'])(
    'denies incompatible isolation %s before SQL',
    async (isolation) => {
      const { tx, query } = port();
      await expect(
        ensureHumanParticipant({ ...tx, isolation } as IdentityTransaction, input),
      ).rejects.toMatchObject({ code: 'STORAGE_CONTRACT' });
      expect(query).not.toHaveBeenCalled();
    },
  );
  it('denies a non-PostgreSQL host capability', async () => {
    const { tx, query } = port();
    await expect(
      ensureHumanParticipant({ ...tx, dialect: 'SQLITE' } as unknown as IdentityTransaction, input),
    ).rejects.toMatchObject({ code: 'STORAGE_CONTRACT' });
    expect(query).not.toHaveBeenCalled();
  });
  it('missing account rejects without an insert', async () => {
    const { tx, query } = port([]);
    await expect(ensureHumanParticipant(tx, input)).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_FOUND',
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...human, kind: 'AI_AGENT' },
    { ...human, accountId: 'other' },
    { ...human, id: '' },
    { ...human, secret: 'private' },
  ])('denies an invalid/cross-account DTO: %j', async (row) => {
    const { tx } = port([row]);
    await expect(findHumanParticipant(tx, 'alice')).rejects.toMatchObject({
      code: 'STORAGE_CONTRACT',
    });
  });
  it('denies duplicate rows and a missing conflict winner', async () => {
    await expect(findHumanParticipant(port([human, human]).tx, 'alice')).rejects.toMatchObject({
      code: 'STORAGE_CONTRACT',
    });
    await expect(
      ensureHumanParticipant(port([{ id: 'alice' }], [], []).tx, input),
    ).rejects.toMatchObject({ code: 'STORAGE_CONTRACT' });
  });
  it('resolves existing/restricted account mapping without granting permissions', async () => {
    expect(await findHumanParticipant(port([human]).tx, 'alice')).toEqual(human);
    expect(await findHumanParticipant(port([]).tx, 'alice')).toBeNull();
    expect(await hasHumanParticipant(port([{ present: true }]).tx, 'alice')).toBe(true);
    expect(await hasHumanParticipant(port([{ present: false }]).tx, 'alice')).toBe(false);
  });
  it.each([[], [{ present: 1 }], [{ present: true }, { present: false }]].map((rows) => [rows]))(
    'fails closed for malformed reference observation: %j',
    async (rows) => {
      await expect(hasHumanParticipant(port(rows).tx, 'alice')).rejects.toMatchObject({
        code: 'STORAGE_CONTRACT',
      });
    },
  );
  it('validates read/reference inputs before querying', async () => {
    const { tx, query } = port();
    await expect(findHumanParticipant(tx, '')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(hasHumanParticipant(tx, '')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(query).not.toHaveBeenCalled();
  });
  it('sanitizes arbitrary alternate-driver exceptions', async () => {
    const { tx } = port();
    tx.query = async () => {
      throw Error('password=secret query=private');
    };
    await expect(findHumanParticipant(tx, 'alice')).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      message: 'STORAGE_UNAVAILABLE',
    });
  });
});
describe('Prisma host failure boundary', () => {
  it.each([
    { code: '40001' },
    { code: '40P01' },
    { code: 'P2010', meta: { code: '40001', message: 'private' } },
    { code: 'P2010', meta: { code: '40P01' } },
    { code: 'P2034' },
  ])('requires entire transaction retry for %j', (error) => {
    expect(classifyIdentityStorageFailure(error)).toMatchObject({
      code: 'RETRY_TRANSACTION',
      message: 'RETRY_TRANSACTION',
    });
  });
  it.each([{ code: '23503' }, Error('private'), { code: 'P2010', meta: { code: '42P01' } }])(
    'unknown/constraint failures remain sanitized visible failures: %j',
    (error) => {
      expect(classifyIdentityStorageFailure(error)).toMatchObject({
        code: 'STORAGE_UNAVAILABLE',
        message: 'STORAGE_UNAVAILABLE',
      });
    },
  );
  it('adapter checks actual isolation rather than trusting a caller declaration', async () => {
    const query = vi.fn().mockResolvedValueOnce([{ transaction_isolation: 'serializable' }]);
    const tx = createPrismaIdentityTransaction({
      $queryRawUnsafe: query,
    } as unknown as Prisma.TransactionClient);
    await expect(findHumanParticipant(tx, 'alice')).rejects.toMatchObject({
      code: 'STORAGE_CONTRACT',
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('adapter never retries a failed statement', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ transaction_isolation: 'read committed' }])
      .mockRejectedValueOnce({ code: 'P2010', meta: { code: '40P01' } });
    const tx = createPrismaIdentityTransaction({
      $queryRawUnsafe: query,
    } as unknown as Prisma.TransactionClient);
    await expect(findHumanParticipant(tx, 'alice')).rejects.toMatchObject({
      code: 'RETRY_TRANSACTION',
    });
    expect(query).toHaveBeenCalledTimes(2);
  });
});
