import { IdentityLinkError } from '../identity-link/contracts';
import { IdentityStorageError } from '../identity-storage/contracts';
import { Prisma, type PrismaClient } from '@prisma/client';
import { IdentityLockError, endIdentityLocks } from '../identity-locks';
import { createPrismaIdentityTransaction } from './identity-storage-adapter';
import {
  CommandReceiptError,
  retryWholeTransaction,
  type CommandReceiptTransaction,
  type SqlBinding,
} from '../command-receipts';

/** Maps driver and Prisma failures to the module's sanitized codes; deadlock and serialization retry. */
export function classifyCommandReceiptFailure(error: unknown): CommandReceiptError {
  if (
    (error instanceof IdentityLinkError || error instanceof IdentityStorageError) &&
    error.code === 'RETRY_TRANSACTION'
  )
    return new CommandReceiptError('RETRY_TRANSACTION');
  if (error instanceof IdentityLockError && error.code === 'PLAN_CHANGED')
    return new CommandReceiptError('RETRY_TRANSACTION');
  if (error instanceof CommandReceiptError) return error;
  const source = error as { code?: unknown; meta?: { code?: unknown } } | null;
  const state = source?.code === 'P2010' ? source.meta?.code : source?.code;
  return new CommandReceiptError(
    state === '40001' || state === '40P01' || source?.code === 'P2034'
      ? 'RETRY_TRANSACTION'
      : 'STORAGE_UNAVAILABLE',
  );
}
/** The host must pass a real interactive transaction opened at READ COMMITTED; checked once. */
export function createPrismaCommandTransaction(
  tx: Prisma.TransactionClient,
): CommandReceiptTransaction {
  let checked: Promise<void> | undefined;
  return {
    dialect: 'POSTGRESQL',
    isolation: 'READ_COMMITTED',
    async query<Row>(sql: string, bindings: readonly SqlBinding[]): Promise<Row[]> {
      try {
        checked ??= (async () => {
          const rows = await tx.$queryRawUnsafe<{ transaction_isolation: string }[]>(
            'SHOW transaction_isolation',
          );
          if (rows.length !== 1 || rows[0].transaction_isolation !== 'read committed')
            throw new CommandReceiptError('STORAGE_CONTRACT');
        })();
        await checked;
        return await tx.$queryRawUnsafe<Row[]>(sql, ...bindings);
      } catch (error) {
        throw classifyCommandReceiptFailure(error);
      }
    },
  };
}
/**
 * Read-only query port for one consistent snapshot. It deliberately is NOT a `CommandReceiptTransaction`: that port is
 * READ COMMITTED and its readers take identity advisory locks, neither of which a snapshot read does.
 */
export interface SnapshotReadTransaction {
  query<Row>(sql: string, bindings: readonly SqlBinding[]): Promise<Row[]>;
}
/** Binds the snapshot port to the already READ ONLY transaction; module-owned SQL only, errors classified. */
export function createPrismaSnapshotPort(tx: Prisma.TransactionClient): SnapshotReadTransaction {
  return {
    async query<Row>(sql: string, bindings: readonly SqlBinding[]): Promise<Row[]> {
      try {
        return await tx.$queryRawUnsafe<Row[]>(sql, ...bindings);
      } catch (error) {
        throw classifyCommandReceiptFailure(error);
      }
    },
  };
}
/**
 * Runs `work` in ONE `REPEATABLE READ`, `READ ONLY` transaction: every query in it sees the same committed state, writes
 * are impossible, and no identity advisory lock is taken (so no lock-order obligation arises; write paths keep theirs).
 * `SET TRANSACTION READ ONLY` precedes the first query, and isolation and access mode are verified before `work` runs.
 * Serialization failures retry the whole transaction, like `runCommandTransaction`; other errors propagate unchanged.
 */
export async function runSnapshotReadTransaction<T>(
  db: Pick<PrismaClient, '$transaction'>,
  work: (port: SnapshotReadTransaction) => Promise<T>,
  options: RunCommandTransactionOptions = {},
): Promise<T> {
  try {
    return await retryWholeTransaction(
      () =>
        db.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
            const modes = await tx.$queryRawUnsafe<{ isolation: string; read_only: string }[]>(
              `SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only`,
            );
            if (
              modes.length !== 1 ||
              modes[0].isolation !== 'repeatable read' ||
              modes[0].read_only !== 'on'
            )
              throw new CommandReceiptError('STORAGE_CONTRACT');
            return work(createPrismaSnapshotPort(tx));
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
            maxWait: options.transaction?.maxWait ?? 2000,
            timeout: options.transaction?.timeout ?? 5000,
          },
        ),
      {
        maxAttempts: options.maxAttempts,
        isRetryable: (error) => classifyCommandReceiptFailure(error).code === 'RETRY_TRANSACTION',
      },
    );
  } catch (error) {
    const classified = classifyCommandReceiptFailure(error);
    if (classified.code === 'RETRY_TRANSACTION') throw classified;
    throw error;
  }
}
export interface RunCommandTransactionOptions {
  maxAttempts?: number;
  maxElapsedMs?: number;
  transaction?: { maxWait?: number; timeout?: number };
}
/**
 * Opens a fresh READ COMMITTED interactive transaction per attempt and retries the whole thing on
 * deadlock/serialization failures. Other errors (domain rejections, typed module errors) propagate
 * unchanged; exhaustion throws RETRY_TRANSACTION. `work` must be repeatable and use the command's
 * original identity on every attempt.
 */
export async function runCommandTransaction<T>(
  db: Pick<PrismaClient, '$transaction'>,
  work: (port: CommandReceiptTransaction, tx: Prisma.TransactionClient) => Promise<T>,
  options: RunCommandTransactionOptions = {},
): Promise<T> {
  const deadline = Date.now() + (options.maxElapsedMs ?? 15000);
  try {
    return await retryWholeTransaction(
      async (attemptNumber) => {
        if (attemptNumber > 1)
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              Math.min(
                50,
                Math.max(0, deadline - Date.now()),
                10 * attemptNumber + Math.floor(Math.random() * 10),
              ),
            ),
          );
        const remaining = deadline - Date.now();
        if (remaining <= 1) throw new CommandReceiptError('RETRY_TRANSACTION');
        const maxWait = Math.min(options.transaction?.maxWait ?? 2000, Math.floor(remaining / 2));
        return db.$transaction(
          async (tx) => {
            try {
              return await work(createPrismaCommandTransaction(tx), tx);
            } finally {
              endIdentityLocks(createPrismaIdentityTransaction(tx));
            }
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
            maxWait,
            timeout: Math.min(options.transaction?.timeout ?? 5000, remaining - maxWait),
          },
        );
      },
      {
        maxAttempts: options.maxAttempts,
        isRetryable: (error) => classifyCommandReceiptFailure(error).code === 'RETRY_TRANSACTION',
      },
    );
  } catch (error) {
    const classified = classifyCommandReceiptFailure(error);
    if (classified.code === 'RETRY_TRANSACTION') throw classified;
    throw error;
  }
}
