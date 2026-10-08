import { ParticipantSchema } from '../contracts/entities';
import { InternalId } from '../contracts/ids';
import {
  IdentityStorageError,
  type HumanParticipant,
  type IdentityTransaction,
  type ProvisionHumanInput,
} from './contracts';
export { IdentityStorageError } from './contracts';
export type {
  HumanParticipant,
  IdentityTransaction,
  IdentityStorageCode,
  ProvisionHumanInput,
} from './contracts';
function validId(value: unknown): asserts value is string {
  if (!InternalId.safeParse(value).success) throw new IdentityStorageError('INVALID_INPUT');
}
function validPort(tx: IdentityTransaction) {
  if (
    tx?.dialect !== 'POSTGRESQL' ||
    tx?.isolation !== 'READ_COMMITTED' ||
    typeof tx.query !== 'function'
  )
    throw new IdentityStorageError('STORAGE_CONTRACT');
}
async function query(
  tx: IdentityTransaction,
  sql: string,
  bindings: readonly string[],
): Promise<unknown[]> {
  try {
    const rows = await tx.query<unknown>(sql, bindings);
    if (!Array.isArray(rows)) throw new IdentityStorageError('STORAGE_CONTRACT');
    return rows;
  } catch (error) {
    if (error instanceof IdentityStorageError) throw error;
    throw new IdentityStorageError('STORAGE_UNAVAILABLE');
  }
}
function humanRow(rows: unknown[], accountId: string): HumanParticipant | null {
  if (!rows.length) return null;
  const result = ParticipantSchema.safeParse(rows[0]);
  if (
    rows.length !== 1 ||
    !result.success ||
    result.data.kind !== 'HUMAN' ||
    result.data.accountId !== accountId
  )
    throw new IdentityStorageError('STORAGE_CONTRACT');
  return result.data;
}
export async function findHumanParticipant(
  tx: IdentityTransaction,
  accountId: string,
): Promise<HumanParticipant | null> {
  validId(accountId);
  validPort(tx);
  return humanRow(
    await query(
      tx,
      'SELECT "id"::text, "kind", "accountId" FROM "Participant" WHERE "accountId" = $1',
      [accountId],
    ),
    accountId,
  );
}
export async function hasHumanParticipant(
  tx: IdentityTransaction,
  accountId: string,
): Promise<boolean> {
  validId(accountId);
  validPort(tx);
  const rows = await query(
    tx,
    'SELECT EXISTS (SELECT 1 FROM "Participant" WHERE "accountId" = $1) AS "present"',
    [accountId],
  );
  const row = rows[0] as { present?: unknown } | undefined;
  if (rows.length !== 1 || typeof row?.present !== 'boolean')
    throw new IdentityStorageError('STORAGE_CONTRACT');
  return row.present;
}
export async function ensureHumanParticipant(
  tx: IdentityTransaction,
  input: ProvisionHumanInput,
): Promise<HumanParticipant> {
  validId(input?.accountId);
  validId(input?.actorAccountId);
  validId(input?.requestId);
  if (input.accountId !== input.actorAccountId) throw new IdentityStorageError('WRONG_ACTOR');
  validPort(tx);
  const accounts = await query(tx, 'SELECT "id" FROM "User" WHERE "id" = $1 FOR KEY SHARE', [
    input.accountId,
  ]);
  if (!accounts.length) throw new IdentityStorageError('ACCOUNT_NOT_FOUND');
  if (accounts.length !== 1 || (accounts[0] as { id?: unknown })?.id !== input.accountId)
    throw new IdentityStorageError('STORAGE_CONTRACT');
  const inserted = await query(
    tx,
    `INSERT INTO "Participant" ("accountId", "provisionActorAccountId", "provisionRequestId")
    VALUES ($1, $2, $3) ON CONFLICT ("accountId") DO NOTHING RETURNING "id"::text, "kind", "accountId"`,
    [input.accountId, input.actorAccountId, input.requestId],
  );
  const mapping =
    humanRow(inserted, input.accountId) ?? (await findHumanParticipant(tx, input.accountId));
  if (!mapping) throw new IdentityStorageError('STORAGE_CONTRACT');
  return mapping;
}
