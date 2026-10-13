import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import {
  CommandReceiptError,
  executeIdempotentCommand,
  type CommandReceiptTransaction,
  type SqlBinding,
} from '../command-receipts';
import {
  SaveGuildDraftInputSchema,
  SavedGuildDraftSchema,
  GuildDraftStorageError,
  type GuildDraftActor,
  type GuildDraftCommand,
  type GuildDraftSaveOptions,
  type SavedGuildDraft,
} from './draft-storage-contracts';
export * from './draft-storage-contracts';
function fail(code: GuildDraftStorageError['code']): never {
  throw new GuildDraftStorageError(code);
}
function validateActor(actor: GuildDraftActor) {
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
    if (error instanceof GuildDraftStorageError || error instanceof CommandReceiptError)
      throw error;
    return fail('STORAGE_UNAVAILABLE');
  }
}
/** Receipt → User → Session → Draft. Actual cookie-derived authority is held to commit. */
async function authorize(tx: CommandReceiptTransaction, actor: GuildDraftActor) {
  const users = await query<{ suspended: boolean }>(
    tx,
    'SELECT "suspended" FROM "User" WHERE "id"=$1 FOR NO KEY UPDATE',
    [actor.accountId],
  );
  if (users.length !== 1) fail('UNAUTHENTICATED');
  if (users[0].suspended) fail('ACCOUNT_RESTRICTED');
  const sessions = await query<{ userId: string; via: string }>(
    tx,
    'SELECT "userId","via" FROM "Session" WHERE "tokenHash"=$1 FOR SHARE',
    [actor.sessionHash],
  );
  if (
    sessions.length !== 1 ||
    sessions[0].userId !== actor.accountId ||
    !['wallet', 'x'].includes(sessions[0].via)
  )
    fail('UNAUTHENTICATED');
  const clock = await query<{ valid: boolean }>(
    tx,
    `SELECT "expiresAt">(clock_timestamp() AT TIME ZONE 'UTC') AS valid FROM "Session" WHERE "tokenHash"=$1`,
    [actor.sessionHash],
  );
  if (clock.length !== 1 || clock[0].valid !== true) fail('UNAUTHENTICATED');
}
async function loadVersion(
  tx: CommandReceiptTransaction,
  actor: GuildDraftActor,
  id: string,
): Promise<SavedGuildDraft> {
  const rows = await query<{
    guildDraftId: string;
    revision: number;
    recordedAt: Date;
    profile: unknown;
  }>(
    tx,
    `SELECT v."guildDraftId"::text,v."revision",v."recordedAt",v."profile" FROM "GuildDraftVersion" v JOIN "GuildDraft" d ON d."id"=v."guildDraftId" AND d."ownerAccountId"=v."ownerAccountId" WHERE v."id"=$1::uuid AND d."ownerAccountId"=$2`,
    [id, actor.accountId],
  );
  if (rows.length !== 1 || !(rows[0].recordedAt instanceof Date)) fail('STORAGE_CONTRACT');
  const parsed = SavedGuildDraftSchema.safeParse({
    version: 'v1',
    id: rows[0].guildDraftId,
    state: 'DRAFT_UNVERIFIED',
    revision: rows[0].revision,
    recordedAt: rows[0].recordedAt.toISOString(),
    profile: rows[0].profile,
    founderControlVerified: false,
    publicProfileApproved: false,
    primaryToken: null,
  });
  if (!parsed.success) fail('STORAGE_CONTRACT');
  return parsed.data;
}
/** Private preparation only; no project verification, actual Guild authority or public publication. */
export async function saveGuildDraft(
  tx: CommandReceiptTransaction,
  command: GuildDraftCommand,
  options: GuildDraftSaveOptions,
): Promise<{ status: 'EXECUTED' | 'REPLAYED'; draft: SavedGuildDraft }> {
  validateActor(command?.actor);
  if (typeof options?.allowNewWrites !== 'boolean') fail('STORAGE_CONTRACT');
  const parsed = SaveGuildDraftInputSchema.safeParse(command.input);
  if (!parsed.success) fail('INVALID_INPUT');
  const input = parsed.data,
    actor = command.actor;
  const result = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'SaveGuildDraft',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: input,
    },
    async ({ receiptId }) => {
      await authorize(tx, actor);
      if (!options.allowNewWrites) fail('WRITES_DISABLED');
      let id = input.guildDraftId;
      if (id !== null) {
        const rows = await query<{ revision: number; slug: string }>(
          tx,
          'SELECT "revision","slug" FROM "GuildDraft" WHERE "id"=$1::uuid AND "ownerAccountId"=$2 FOR UPDATE',
          [id, actor.accountId],
        );
        if (rows.length !== 1) fail('NOT_FOUND');
        // Row acquisition may wait past expiry. Never use transaction-start or client time.
        await authorize(tx, actor);
        if (rows[0].revision !== input.expectedRevision) fail('REVISION_CONFLICT');
        if (rows[0].slug !== input.profile.slug) fail('SLUG_IMMUTABLE');
      } else {
        const ids = await query<{ id: string }>(tx, 'SELECT gen_random_uuid()::text AS id', []);
        if (ids.length !== 1 || !z.uuid().safeParse(ids[0].id).success) fail('STORAGE_CONTRACT');
        id = ids[0].id;
      }
      const versions = await query<{ id: string }>(
        tx,
        `INSERT INTO "GuildDraftVersion" ("guildDraftId","ownerAccountId","revision","profile","receiptId","actorAccountId","requestId") VALUES ($1::uuid,$2,$3::int,$4::jsonb,$5::uuid,$2,$6) RETURNING "id"::text`,
        [
          id,
          actor.accountId,
          String(input.expectedRevision + 1),
          JSON.stringify(input.profile),
          receiptId,
          command.requestId,
        ],
      );
      if (versions.length !== 1 || !z.uuid().safeParse(versions[0].id).success)
        fail('STORAGE_CONTRACT');
      const versionId = versions[0].id;
      const projections = await query<{ id: string }>(
        tx,
        input.guildDraftId === null
          ? `INSERT INTO "GuildDraft" ("id","ownerAccountId","slug","revision","currentVersionId") VALUES ($1::uuid,$2,$3,$4::int,$5::uuid) ON CONFLICT ("slug") DO NOTHING RETURNING "id"::text`
          : `UPDATE "GuildDraft" SET "revision"=$4::int,"currentVersionId"=$5::uuid WHERE "id"=$1::uuid AND "ownerAccountId"=$2 AND "slug"=$3 RETURNING "id"::text`,
        [id, actor.accountId, input.profile.slug, String(input.expectedRevision + 1), versionId],
      );
      if (projections.length === 0 && input.guildDraftId === null) fail('SLUG_UNAVAILABLE');
      if (projections.length !== 1) fail('STORAGE_CONTRACT');
      // Unique slug acquisition can also wait; expiry must roll back all prepared writes.
      await authorize(tx, actor);
      return {
        resultRef: versionId,
        events: [
          {
            type: 'guild.draft_recorded.v1',
            aggregateId: id,
            aggregateVersion: input.expectedRevision + 1,
            payload: { guildDraftVersionId: versionId },
            publish: false,
          },
        ],
      };
    },
  );
  // Replays skip the handler and must still prove current own authority.
  await authorize(tx, actor);
  return { status: result.status, draft: await loadVersion(tx, actor, result.resultRef) };
}
export async function readGuildDraft(
  tx: CommandReceiptTransaction,
  actor: GuildDraftActor,
  id: string,
): Promise<SavedGuildDraft> {
  validateActor(actor);
  if (!z.uuid().safeParse(id).success) fail('INVALID_INPUT');
  await authorize(tx, actor);
  const rows = await query<{ currentVersionId: string }>(
    tx,
    'SELECT "currentVersionId"::text FROM "GuildDraft" WHERE "id"=$1::uuid AND "ownerAccountId"=$2',
    [id, actor.accountId],
  );
  if (rows.length !== 1) fail('NOT_FOUND');
  return loadVersion(tx, actor, rows[0].currentVersionId);
}
