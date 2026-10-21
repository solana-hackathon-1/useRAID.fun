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
