import type { Prisma } from '@prisma/client';
import { IdentityStorageError, type IdentityTransaction } from '../identity-storage';
export function classifyIdentityStorageFailure(error: unknown): IdentityStorageError {
  if (error instanceof IdentityStorageError) return error;
  const source = error as { code?: unknown; meta?: { code?: unknown } } | null;
  const state = source?.code === 'P2010' ? source.meta?.code : source?.code;
  return new IdentityStorageError(
    state === '40001' || state === '40P01' || source?.code === 'P2034'
      ? 'RETRY_TRANSACTION'
      : 'STORAGE_UNAVAILABLE',
  );
}
export function createPrismaIdentityTransaction(tx: Prisma.TransactionClient): IdentityTransaction {
  // Host must pass a real interactive transaction. Check its actual isolation once.
  let checked: Promise<void> | undefined;
  return {
    dialect: 'POSTGRESQL',
    isolation: 'READ_COMMITTED',
    async query<Row>(sql: string, bindings: readonly string[]): Promise<Row[]> {
      try {
        checked ??= (async () => {
          const rows = await tx.$queryRawUnsafe<{ transaction_isolation: string }[]>(
            'SHOW transaction_isolation',
          );
          if (rows.length !== 1 || rows[0].transaction_isolation !== 'read committed')
            throw new IdentityStorageError('STORAGE_CONTRACT');
        })();
        await checked;
        return await tx.$queryRawUnsafe<Row[]>(sql, ...bindings);
      } catch (error) {
        throw classifyIdentityStorageFailure(error);
      }
    },
  };
}
