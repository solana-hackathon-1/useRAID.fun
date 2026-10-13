import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import {
  executeIdempotentCommand,
  CommandReceiptError,
  type CommandReceiptTransaction,
  type SqlBinding,
} from '../command-receipts';
import { readGuildDraft } from './draft-storage';
import {
  SaveGuildProjectProposalInputSchema,
  SavedGuildProjectProposalSchema,
  GuildDraftStorageError,
  type GuildDraftActor,
  type GuildDraftCommand,
  type GuildDraftSaveOptions,
  type SavedGuildProjectProposal,
} from './project-proposal-contracts';
export * from './project-proposal-contracts';
function fail(code: GuildDraftStorageError['code']): never {
  throw new GuildDraftStorageError(code);
}
function actorValid(actor: GuildDraftActor) {
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
async function load(
  tx: CommandReceiptTransaction,
  actor: GuildDraftActor,
  id: string,
): Promise<SavedGuildProjectProposal> {
  const rows = await query<{
    id: string;
    guildDraftId: string;
    revision: number;
    draftRevision: number;
    recordedAt: Date;
    candidateToken: unknown;
    publicEvidenceRefs: unknown;
  }>(
    tx,
    `SELECT v."id"::text,v."guildDraftId"::text,v."revision",v."draftRevision",v."recordedAt",v."candidateToken",v."publicEvidenceRefs" FROM "GuildProjectProposalVersion" v JOIN "GuildProjectProposal" p ON p."guildDraftId"=v."guildDraftId" AND p."ownerAccountId"=v."ownerAccountId" WHERE v."id"=$1::uuid AND p."ownerAccountId"=$2`,
    [id, actor.accountId],
  );
  if (rows.length !== 1 || !(rows[0].recordedAt instanceof Date)) fail('STORAGE_CONTRACT');
  const row = rows[0];
  const result = SavedGuildProjectProposalSchema.safeParse({
    ...row,
    recordedAt: row.recordedAt.toISOString(),
    version: 'v1',
    projectType: 'EXISTING_PROJECT',
    state: 'PENDING_VERIFICATION',
    persisted: true,
    founderControlVerified: false,
    recognizesGuild: false,
    activatesToken: false,
    createsPermissionGrant: false,
    publicProfileApproved: false,
  });
  if (!result.success) fail('STORAGE_CONTRACT');
  return result.data;
}
/** Private pending claim only. Receipt → User → Session → Draft → Proposal; no verified relationship. */
export async function saveGuildProjectProposal(
  tx: CommandReceiptTransaction,
  command: GuildDraftCommand,
  options: GuildDraftSaveOptions,
): Promise<{ status: 'EXECUTED' | 'REPLAYED'; proposal: SavedGuildProjectProposal }> {
  actorValid(command?.actor);
  if (typeof options?.allowNewWrites !== 'boolean') fail('STORAGE_CONTRACT');
  const parsed = SaveGuildProjectProposalInputSchema.safeParse(command.input);
  if (!parsed.success) fail('INVALID_INPUT');
  const input = parsed.data,
    actor = command.actor;
  let result;
  try {
    result = await executeIdempotentCommand(
      tx,
      {
        actorId: actor.accountId,
        commandKind: 'SaveGuildProjectProposal',
        idempotencyKey: command.idempotencyKey,
        requestId: command.requestId,
        request: input,
      },
      async ({ receiptId }) => {
        const draft = await readGuildDraft(tx, actor, input.guildDraftId);
        if (!options.allowNewWrites) fail('WRITES_DISABLED');
        const snapshots = await query<{ currentVersionId: string; revision: number }>(
          tx,
          'SELECT "currentVersionId"::text,"revision" FROM "GuildDraft" WHERE "id"=$1::uuid AND "ownerAccountId"=$2 FOR SHARE',
          [input.guildDraftId, actor.accountId],
        );
        // A direct/current draft writer may have held the row: recheck current session after acquiring it.
        await readGuildDraft(tx, actor, input.guildDraftId);
        if (snapshots.length !== 1) fail('NOT_FOUND');
        if (
          draft.revision !== input.expectedDraftRevision ||
          snapshots[0].revision !== input.expectedDraftRevision
        )
          fail('REVISION_CONFLICT');
        const current = await query<{ revision: number }>(
          tx,
          'SELECT "revision" FROM "GuildProjectProposal" WHERE "guildDraftId"=$1::uuid AND "ownerAccountId"=$2 FOR UPDATE',
          [input.guildDraftId, actor.accountId],
        );
        await readGuildDraft(tx, actor, input.guildDraftId);
        if (current.length > 1) fail('STORAGE_CONTRACT');
        if ((current[0]?.revision ?? 0) !== input.expectedProposalRevision)
          fail('REVISION_CONFLICT');
        const versions = await query<{ id: string }>(
          tx,
          `INSERT INTO "GuildProjectProposalVersion" ("guildDraftId","ownerAccountId","revision","draftVersionId","draftRevision","candidateToken","publicEvidenceRefs","receiptId","actorAccountId","requestId") VALUES($1::uuid,$2,$3::int,$4::uuid,$5::int,$6::jsonb,$7::jsonb,$8::uuid,$2,$9) RETURNING "id"::text`,
          [
            input.guildDraftId,
            actor.accountId,
            String(input.expectedProposalRevision + 1),
            snapshots[0].currentVersionId,
            String(input.expectedDraftRevision),
            JSON.stringify(input.candidateToken),
            JSON.stringify(input.publicEvidenceRefs),
            receiptId,
            command.requestId,
          ],
        );
        if (versions.length !== 1 || !z.uuid().safeParse(versions[0].id).success)
          fail('STORAGE_CONTRACT');
        const versionId = versions[0].id;
        const projections = await query<{ id: string }>(
          tx,
          current.length === 0
            ? `INSERT INTO "GuildProjectProposal"("guildDraftId","ownerAccountId","revision","currentVersionId") VALUES($1::uuid,$2,$3::int,$4::uuid) RETURNING "guildDraftId"::text AS id`
            : `UPDATE "GuildProjectProposal" SET "revision"=$3::int,"currentVersionId"=$4::uuid WHERE "guildDraftId"=$1::uuid AND "ownerAccountId"=$2 RETURNING "guildDraftId"::text AS id`,
          [
            input.guildDraftId,
            actor.accountId,
            String(input.expectedProposalRevision + 1),
            versionId,
          ],
        );
        if (projections.length !== 1) fail('STORAGE_CONTRACT');
        await readGuildDraft(tx, actor, input.guildDraftId);
        return {
          resultRef: versionId,
          events: [
            {
              type: 'guild.project_proposal_recorded.v1',
              aggregateId: input.guildDraftId,
              aggregateVersion: input.expectedProposalRevision + 1,
              payload: { projectProposalVersionId: versionId },
              publish: false,
            },
          ],
        };
      },
    );
  } catch (error) {
    // A digest conflict is a JS contract error (not a SQL abort); authenticate before disclosing it.
    if (error instanceof CommandReceiptError && error.code === 'IDEMPOTENCY_KEY_REUSED')
      await readGuildDraft(tx, actor, input.guildDraftId);
    throw error;
  }
  await readGuildDraft(tx, actor, input.guildDraftId);
  const proposal = await load(tx, actor, result.resultRef);
  await readGuildDraft(tx, actor, input.guildDraftId);
  return { status: result.status, proposal };
}
export async function readGuildProjectProposal(
  tx: CommandReceiptTransaction,
  actor: GuildDraftActor,
  id: string,
): Promise<SavedGuildProjectProposal | null> {
  actorValid(actor);
  if (!z.uuid().safeParse(id).success) fail('INVALID_INPUT');
  await readGuildDraft(tx, actor, id);
  const rows = await query<{ currentVersionId: string }>(
    tx,
    'SELECT "currentVersionId"::text FROM "GuildProjectProposal" WHERE "guildDraftId"=$1::uuid AND "ownerAccountId"=$2',
    [id, actor.accountId],
  );
  if (rows.length > 1) fail('STORAGE_CONTRACT');
  const result = rows.length === 1 ? await load(tx, actor, rows[0].currentVersionId) : null;
  await readGuildDraft(tx, actor, id);
  return result;
}
