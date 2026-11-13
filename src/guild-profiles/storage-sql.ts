import { InternalId } from '../contracts/ids';
import {
  CommandReceiptError,
  type CommandReceiptTransaction,
  type SqlBinding,
} from '../command-receipts';

/**
 * Helpers shared by the Guild storage modules (`draft-storage`, `project-proposal-storage`, `guild-storage`). Each
 * module keeps its own error class and `fail`; only the identical mechanics live here. Host dependency: none beyond
 * the command-receipt transaction.
 */

/** A module's `fail`: throws that module's own error type for a code. */
export type StorageFail<Code extends string> = (code: Code) => never;

/**
 * Builds a module's `query`: checks the transaction is the PostgreSQL READ COMMITTED port, verifies the row array, and
 * maps any driver failure to STORAGE_UNAVAILABLE. A module's own error and a receipt error pass through unchanged.
 * `retryTransient` also maps a deadlock or serialization abort (SQLSTATE 40P01/40001, directly or as Prisma's raw
 * query `meta.code`) to a whole-transaction retry instead of an outage.
 */
export function createStorageQuery<
  Code extends 'STORAGE_CONTRACT' | 'STORAGE_UNAVAILABLE',
  Err extends Error,
>(
  fail: StorageFail<Code>,
  isOwnError: (error: unknown) => error is Err,
  options: { retryTransient: boolean },
) {
  return async function query<Row>(
    tx: CommandReceiptTransaction,
    sql: string,
    bindings: readonly SqlBinding[],
  ): Promise<Row[]> {
    if (
      tx?.dialect !== 'POSTGRESQL' ||
      tx?.isolation !== 'READ_COMMITTED' ||
      typeof tx.query !== 'function'
    )
      fail('STORAGE_CONTRACT' as Code);
    try {
      const rows = await tx.query<Row>(sql, bindings);
      if (!Array.isArray(rows)) fail('STORAGE_CONTRACT' as Code);
      return rows;
    } catch (error) {
      if (isOwnError(error) || error instanceof CommandReceiptError) throw error;
      if (options.retryTransient) {
        // A deadlock or serialization abort is retryable whole, never an outage. A host port classifies these itself;
        // one that hands the driver error through gets the same answer here, so two approvers activating each
        // other's drafts (#438-2) never surface STORAGE_UNAVAILABLE.
        const source = error as { code?: unknown; meta?: { code?: unknown } } | null;
        const state = source?.code === 'P2010' ? source.meta?.code : source?.code;
        if (state === '40P01' || state === '40001')
          throw new CommandReceiptError('RETRY_TRANSACTION');
      }
      return fail('STORAGE_UNAVAILABLE' as Code);
    }
  };
}

const SESSION_HASH = /^[a-f0-9]{64}$/;
/**
 * Shape check of the cookie-derived actor: INVALID_INPUT for a malformed account id, UNAUTHENTICATED for a missing or
 * malformed session hash. It decides nothing about authority; `authorize` does that against the database.
 */
export function validateSessionActor(
  fail: StorageFail<'INVALID_INPUT' | 'UNAUTHENTICATED'>,
  actor: { accountId: string; sessionHash: string },
) {
  if (!InternalId.safeParse(actor?.accountId).success) fail('INVALID_INPUT');
  if (typeof actor.sessionHash !== 'string' || !SESSION_HASH.test(actor.sessionHash))
    fail('UNAUTHENTICATED');
}

/** As `validateSessionActor`, for a command whose actor is also the account it acts for (else WRONG_ACTOR). */
export function validateOwnSessionActor(
  fail: StorageFail<'INVALID_INPUT' | 'UNAUTHENTICATED' | 'WRONG_ACTOR'>,
  actor: { accountId: string; actorAccountId: string; sessionHash: string },
) {
  if (
    !InternalId.safeParse(actor?.accountId).success ||
    !InternalId.safeParse(actor?.actorAccountId).success
  )
    fail('INVALID_INPUT');
  if (actor.accountId !== actor.actorAccountId) fail('WRONG_ACTOR');
  if (typeof actor.sessionHash !== 'string' || !SESSION_HASH.test(actor.sessionHash))
    fail('UNAUTHENTICATED');
}

/** Grant liveness at the database clock (`clock_timestamp()`); `alias` is a table prefix such as `r.`. */
export const liveGrantSql = (alias = '') =>
  `${alias}"revokedAt" IS NULL AND ${alias}"validFrom"<=clock_timestamp() AND (${alias}"expiresAt" IS NULL OR ${alias}"expiresAt">clock_timestamp())`;

/** Live at a bound instant (placeholder `$n`), so several reads in one command judge grants at the same moment. */
export const liveGrantAtSql = (n: number, alias = '') =>
  `${alias}"revokedAt" IS NULL AND ${alias}"validFrom"<=$${n}::timestamptz AND (${alias}"expiresAt" IS NULL OR ${alias}"expiresAt">$${n}::timestamptz)`;

/** Not revoked and not expired at the database clock, ignoring `validFrom` (a not-yet-valid grant still counts). */
export const unexpiredGrantSql = (alias = '') =>
  `${alias}"revokedAt" IS NULL AND (${alias}"expiresAt" IS NULL OR ${alias}"expiresAt">clock_timestamp())`;
