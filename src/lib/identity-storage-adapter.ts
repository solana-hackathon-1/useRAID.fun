import type { Prisma } from '@prisma/client';
import { IdentityStorageError, type IdentityTransaction } from '../identity-storage';
import { IdentityLockError } from '../identity-locks';
const ports = new WeakMap<Prisma.TransactionClient, IdentityTransaction>();
export function classifyIdentityStorageFailure(error: unknown): IdentityStorageError {
  if (error instanceof IdentityStorageError) return error;
  const source = error as { code?: unknown; meta?: { code?: unknown } } | null;
  const state = source?.code === 'P2010' ? source.meta?.code : source?.code;
  // Classify by SQLSTATE or Prisma code only. Prisma's raw error carries no constraint name and its
  // message can contain the conflicting value, so neither is ever read or forwarded (WR01).
  if (state === '40001' || state === '40P01' || source?.code === 'P2034')
    return new IdentityStorageError('RETRY_TRANSACTION');
  if (state === '23505' || source?.code === 'P2002')
    return new IdentityStorageError('UNIQUE_CONFLICT');
  return new IdentityStorageError('STORAGE_UNAVAILABLE');
}
export function createPrismaIdentityTransaction(tx: Prisma.TransactionClient): IdentityTransaction {
  const existing = ports.get(tx);
  if (existing) return existing;
  // Host must pass a real interactive transaction. Check its actual isolation once.
  let checked: Promise<void> | undefined;
  const port: IdentityTransaction = {
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
        if (error instanceof IdentityLockError) throw error;
        throw classifyIdentityStorageFailure(error);
      }
    },
  };
  ports.set(tx, port);
  return port;
}
