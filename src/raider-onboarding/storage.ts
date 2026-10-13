import { InternalId } from '../contracts/ids';
import {
  CommandReceiptError,
  executeIdempotentCommand,
  type CommandReceiptTransaction,
  type SqlBinding,
} from '../command-receipts';
import { ensureHumanParticipant, IdentityStorageError } from '../identity-storage';
import type { RaiderOnboardingHost } from './contracts';
import { prepareRaiderOrientation, normalizeRaiderOrientationPreferences } from './index';

import {
  SaveRaiderOrientationInputSchema,
  SavedOrientationSchema,
  OrientationStorageError,
  type OrientationActor,
  type OrientationSaveOptions,
  type SaveOrientationCommand,
  type SavedOrientation,
} from './storage-contracts';
export * from './storage-contracts';
function fail(code: OrientationStorageError['code']): never {
  throw new OrientationStorageError(code);
}
function validateActor(actor: OrientationActor) {
  if (
    !InternalId.safeParse(actor?.accountId).success ||
    !InternalId.safeParse(actor?.actorAccountId).success
  )
    fail('INVALID_INPUT');
  if (actor.accountId !== actor.actorAccountId) fail('WRONG_ACTOR');
  if (typeof actor.sessionHash !== 'string' || !/^[a-f0-9]{64}$/.test(actor.sessionHash))
    fail('UNAUTHENTICATED');
}
async function query<Row>(
  tx: CommandReceiptTransaction,
  sql: string,
  bindings: readonly SqlBinding[],
): Promise<Row[]> {
  if (
    tx?.dialect !== 'POSTGRESQL' ||
    tx?.isolation !== 'READ_COMMITTED' ||
    typeof tx.query !== 'function'
  )
    fail('STORAGE_CONTRACT');
  try {
    const rows = await tx.query<Row>(sql, bindings);
    if (!Array.isArray(rows)) fail('STORAGE_CONTRACT');
    return rows;
  } catch (error) {
    if (error instanceof OrientationStorageError || error instanceof CommandReceiptError)
      throw error;
    return fail('STORAGE_UNAVAILABLE');
  }
}
/** Receipt first; then User → Session. Hold authority rows until commit, clock AFTER locks. */
async function authorize(tx: CommandReceiptTransaction, actor: OrientationActor) {
  const users = await query<{ id: string; suspended: boolean }>(
    tx,
    'SELECT "id", "suspended" FROM "User" WHERE "id" = $1 FOR NO KEY UPDATE',
    [actor.accountId],
  );
  if (users.length !== 1) fail('UNAUTHENTICATED');
  if (users[0].suspended) fail('ACCOUNT_RESTRICTED');
  const sessions = await query<{ userId: string; via: string }>(
    tx,
    'SELECT "userId", "via" FROM "Session" WHERE "tokenHash" = $1 FOR SHARE',
    [actor.sessionHash],
  );
  if (
    sessions.length !== 1 ||
    sessions[0].userId !== actor.accountId ||
    !['x', 'wallet'].includes(sessions[0].via)
  )
    fail('UNAUTHENTICATED');
  // expiresAt is the existing UTC timestamp-without-timezone session column. Do not use now(),
  // transaction_timestamp(), a client clock or a clock evaluated before a row-lock wait.
  const clock = await query<{ valid: boolean }>(
    tx,
    `SELECT "expiresAt" > (clock_timestamp() AT TIME ZONE 'UTC') AS "valid" FROM "Session" WHERE "tokenHash" = $1`,
    [actor.sessionHash],
  );
  if (clock.length !== 1 || clock[0].valid !== true) fail('UNAUTHENTICATED');
}
async function loadVersion(
  tx: CommandReceiptTransaction,
  accountId: string,
  id: string,
): Promise<SavedOrientation> {
  const rows = await query<{ revision: number; recordedAt: Date; preferences: unknown }>(
    tx,
    'SELECT "revision", "recordedAt", "preferences" FROM "RaiderPreferenceVersion" WHERE "id" = $1::uuid AND "accountId" = $2',
    [id, accountId],
  );
  if (rows.length !== 1 || !(rows[0].recordedAt instanceof Date)) fail('STORAGE_CONTRACT');
  const result = SavedOrientationSchema.safeParse({
    version: 'v1',
    state: 'RECORDED',
    revision: rows[0].revision,
    recordedAt: rows[0].recordedAt.toISOString(),
    preferences: rows[0].preferences,
  });
  if (!result.success) fail('STORAGE_CONTRACT');
  return result.data;
}
/** One actual READ COMMITTED transaction owns receipt, mapping, versions/projection and private audit. */
export async function saveRaiderOrientation(
  tx: CommandReceiptTransaction,
  command: SaveOrientationCommand,
  host: RaiderOnboardingHost,
  options: OrientationSaveOptions = { allowNewWrites: true },
): Promise<{ status: 'EXECUTED' | 'REPLAYED'; orientation: SavedOrientation }> {
  validateActor(command?.actor);
  if (typeof options?.allowNewWrites !== 'boolean') fail('STORAGE_CONTRACT');
  const parsed = SaveRaiderOrientationInputSchema.safeParse(command.input);
  if (!parsed.success) fail('INVALID_INPUT');
  const preferences = normalizeRaiderOrientationPreferences(parsed.data.preferences);
  const { actor } = command;
  const result = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'SaveRaiderOrientation',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: { expectedRevision: parsed.data.expectedRevision, preferences },
    },
    async ({ receiptId }) => {
      await authorize(tx, actor);
      if (!options.allowNewWrites) fail('WRITES_DISABLED');
      prepareRaiderOrientation(parsed.data.preferences, host);
      const current = await query<{ revision: number }>(
        tx,
        'SELECT "revision" FROM "RaiderPreferences" WHERE "accountId" = $1',
        [actor.accountId],
      );
      if (current.length > 1) fail('STORAGE_CONTRACT');
      const revision = current[0]?.revision ?? 0;
      if (revision !== parsed.data.expectedRevision) fail('REVISION_CONFLICT');
      // Same underlying connection. Preserve retry classification across the identity port wrapper.
      let participant;
      try {
        participant = await ensureHumanParticipant(
          {
            dialect: tx.dialect,
            isolation: tx.isolation,
            async query<Row>(sql: string, bindings: readonly string[]): Promise<Row[]> {
              try {
                return await tx.query<Row>(sql, bindings);
              } catch (error) {
                if (error instanceof CommandReceiptError && error.code === 'RETRY_TRANSACTION')
                  throw new IdentityStorageError('RETRY_TRANSACTION');
                throw error;
              }
            },
          },
          {
            accountId: actor.accountId,
            actorAccountId: actor.actorAccountId,
            requestId: command.requestId,
          },
        );
      } catch (error) {
        if (error instanceof IdentityStorageError && error.code === 'RETRY_TRANSACTION')
          throw new CommandReceiptError('RETRY_TRANSACTION');
        fail('STORAGE_UNAVAILABLE');
      }
      // Provisioning can also wait on a pre-existing mapping. Expiry advances during that wait.
      await authorize(tx, actor);
      const versions = await query<{ id: string }>(
        tx,
        `INSERT INTO "RaiderPreferenceVersion" ("accountId", "participantId", "revision", "preferences", "receiptId", "actorAccountId", "requestId")
         VALUES ($1, $2::uuid, $3::int, $4::jsonb, $5::uuid, $1, $6) RETURNING "id"::text`,
        [
          actor.accountId,
          participant.id,
          String(revision + 1),
          JSON.stringify(preferences),
          receiptId,
          command.requestId,
        ],
      );
      if (versions.length !== 1 || !InternalId.safeParse(versions[0].id).success)
        fail('STORAGE_CONTRACT');
      const id = versions[0].id;
      await query(
        tx,
        revision === 0
          ? `INSERT INTO "RaiderPreferences" ("accountId", "participantId", "revision", "currentVersionId") VALUES ($1, $2::uuid, $3::int, $4::uuid)`
          : `UPDATE "RaiderPreferences" SET "revision" = $3::int, "currentVersionId" = $4::uuid WHERE "accountId" = $1 AND "participantId" = $2::uuid`,
        [actor.accountId, participant.id, String(revision + 1), id],
      );
      return {
        resultRef: id,
        events: [
          {
            type: 'identity.onboarding_recorded.v1',
            aggregateId: actor.accountId,
            aggregateVersion: revision + 1,
            payload: { orientationVersionId: id },
            publish: false,
          },
        ],
      };
    },
  );
  // A receipt replay skips the handler. It still requires the current own live session.
  await authorize(tx, actor);
  return {
    status: result.status,
    orientation: await loadVersion(tx, actor.accountId, result.resultRef),
  };
}
/** Owned reads stay available independently of the host's new-write feature switch. */
export async function readRaiderOrientation(
  tx: CommandReceiptTransaction,
  actor: OrientationActor,
): Promise<SavedOrientation | null> {
  validateActor(actor);
  await authorize(tx, actor);
  const rows = await query<{ currentVersionId: string }>(
    tx,
    'SELECT "currentVersionId"::text FROM "RaiderPreferences" WHERE "accountId" = $1',
    [actor.accountId],
  );
  if (rows.length > 1) fail('STORAGE_CONTRACT');
  return rows.length ? loadVersion(tx, actor.accountId, rows[0].currentVersionId) : null;
}
