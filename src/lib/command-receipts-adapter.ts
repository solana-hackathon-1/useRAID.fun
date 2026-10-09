import { Prisma, type PrismaClient } from '@prisma/client';
import {
  CommandReceiptError,
  retryWholeTransaction,
  type CommandReceiptTransaction,
  type SqlBinding,
} from '../command-receipts';

/** Maps driver and Prisma failures to the module's sanitized codes; deadlock and serialization retry. */
export function classifyCommandReceiptFailure(error: unknown): CommandReceiptError {
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
  try {
    return await retryWholeTransaction(
      () =>
        db.$transaction((tx) => work(createPrismaCommandTransaction(tx), tx), {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          ...options.transaction,
        }),
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
