import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import { ParticipantSchema } from '../contracts/entities';
import {
  executeIdempotentCommand,
  CommandReceiptError,
  type CommandReceiptTransaction,
  type SqlBinding,
} from '../command-receipts';
import { prepareSkillClaim } from './index';
import { SkillClaimContractError } from './contracts';
import { readPublishedSkillTaxonomy } from './taxonomy-storage';
import {
  SkillClaimActorSchema,
  SaveSkillClaimInputSchema,
  SavedSkillClaimSchema,
  SkillClaimStorageError,
  type SkillClaimActor,
  type SaveSkillClaimCommand,
  type SkillClaimSaveOptions,
  type SavedSkillClaim,
} from './claim-storage-contracts';
export * from './claim-storage-contracts';
function fail(code: SkillClaimStorageError['code']): never {
  throw new SkillClaimStorageError(code);
}
function validActor(value: unknown): SkillClaimActor {
  const result = SkillClaimActorSchema.safeParse(value);
  if (!result.success) fail('INVALID_INPUT');
  return result.data;
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
    if (error instanceof CommandReceiptError || error instanceof SkillClaimStorageError)
      throw error;
    return fail('STORAGE_UNAVAILABLE');
  }
}
async function authorize(tx: CommandReceiptTransaction, actor: SkillClaimActor) {
  const users = await query<{ suspended: boolean }>(
    tx,
    'SELECT "suspended" FROM "User" WHERE "id"=$1 FOR NO KEY UPDATE',
    [actor.accountId],
  );
  if (users.length !== 1) fail('AUTHENTICATION_REQUIRED');
  if (users[0].suspended !== false) fail('ACCOUNT_RESTRICTED');
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
    fail('AUTHENTICATION_REQUIRED');
  const clocks = await query<{ valid: boolean }>(
    tx,
    `SELECT "expiresAt">(clock_timestamp() AT TIME ZONE 'UTC') AS valid FROM "Session" WHERE "tokenHash"=$1`,
    [actor.sessionHash],
  );
  if (clocks.length !== 1 || clocks[0].valid !== true) fail('AUTHENTICATION_REQUIRED');
}
async function canonicalParticipant(tx: CommandReceiptTransaction, actor: SkillClaimActor) {
  const rows = await query(
    tx,
    'SELECT "id"::text,"kind","accountId" FROM "Participant" WHERE "accountId"=$1 FOR SHARE',
    [actor.accountId],
  );
  if (rows.length === 0) fail('RESOURCE_UNAVAILABLE');
  const parsed = ParticipantSchema.safeParse(rows[0]);
  if (
    rows.length !== 1 ||
    !parsed.success ||
    parsed.data.kind !== 'HUMAN' ||
    parsed.data.accountId !== actor.accountId
  )
    fail('STORAGE_CONTRACT');
  await authorize(tx, actor);
  return parsed.data;
}
async function loadVersion(
  tx: CommandReceiptTransaction,
  actor: SkillClaimActor,
  participantId: string,
  versionId: string,
): Promise<SavedSkillClaim> {
  const rows = await query<{
    skillClaimId: string;
    revision: number;
    participantId: string;
    skillId: string;
    skillDomain: string;
    taxonomyId: string;
    taxonomyRevision: number;
    recordedAt: Date;
    claimedLevel: string;
    supportingReferences: unknown;
  }>(
    tx,
    'SELECT "skillClaimId"::text,"revision","participantId"::text,"skillId","skillDomain","taxonomyId","taxonomyRevision","recordedAt","claimedLevel","supportingReferences" FROM "SkillClaimVersion" WHERE "id"=$1::uuid AND "accountId"=$2 AND "participantId"=$3::uuid',
    [versionId, actor.accountId, participantId],
  );
  if (
    rows.length !== 1 ||
    !(rows[0].recordedAt instanceof Date) ||
    Number.isNaN(rows[0].recordedAt.getTime())
  )
    fail('STORAGE_CONTRACT');
  const r = rows[0];
  const parsed = SavedSkillClaimSchema.safeParse({
    version: 'v1',
    id: r.skillClaimId,
    revision: r.revision,
    state: 'CLAIMED',
    participantId: r.participantId,
    skillId: r.skillId,
    skillDomain: r.skillDomain,
    taxonomyReference: { recordId: r.taxonomyId, revision: r.taxonomyRevision },
    recordedAt: r.recordedAt.toISOString(),
    claimedLevel: r.claimedLevel,
    supportingReferences: r.supportingReferences,
    persisted: true,
    informational: true,
    isAuthorizationToken: false,
    verifiesSkill: false,
    createsPermissionGrant: false,
    consumesCapacity: false,
  });
  if (!parsed.success) fail('STORAGE_CONTRACT');
  return parsed.data;
}
/** Private claimant fields only. Receipt → User → Session → Participant → catalog → claim. */
export async function saveSkillClaim(
  tx: CommandReceiptTransaction,
  command: SaveSkillClaimCommand,
  options: SkillClaimSaveOptions,
): Promise<{ status: 'EXECUTED' | 'REPLAYED'; claim: SavedSkillClaim }> {
  const actor = validActor(command?.actor);
  if (typeof options?.allowNewWrites !== 'boolean') fail('STORAGE_CONTRACT');
  const parsed = SaveSkillClaimInputSchema.safeParse(command.input);
  if (!parsed.success) fail('INVALID_INPUT');
  const input = parsed.data;
  let result;
  try {
    result = await executeIdempotentCommand(
      tx,
      {
        actorId: actor.accountId,
        commandKind: 'SaveSkillClaim',
        idempotencyKey: command.idempotencyKey,
        requestId: command.requestId,
        request: input,
      },
      async ({ receiptId }) => {
        await authorize(tx, actor);
        if (!options.allowNewWrites) fail('WRITES_DISABLED');
        const participant = await canonicalParticipant(tx, actor);
        const catalogRows = await query<{ currentVersionId: string; revision: number }>(
          tx,
          'SELECT "currentVersionId"::text,"revision" FROM "SkillTaxonomy" WHERE "id"=$1 FOR SHARE',
          [input.taxonomyId],
        );
        await authorize(tx, actor);
        if (catalogRows.length === 0) fail('RESOURCE_UNAVAILABLE');
        if (catalogRows.length !== 1) fail('STORAGE_CONTRACT');
        if (catalogRows[0].revision !== input.expectedTaxonomyRevision)
          throw new SkillClaimContractError('REVISION_CHANGED');
        const taxonomy = await readPublishedSkillTaxonomy(tx, actor, input.taxonomyId);
        if (taxonomy === null || taxonomy.revision !== catalogRows[0].revision)
          fail('STORAGE_CONTRACT');
        const clocks = await query<{ now: Date }>(
          tx,
          "SELECT date_trunc('milliseconds',clock_timestamp()) AS now",
          [],
        );
        if (
          clocks.length !== 1 ||
          !(clocks[0].now instanceof Date) ||
          Number.isNaN(clocks[0].now.getTime())
        )
          fail('STORAGE_CONTRACT');
        const prepared = prepareSkillClaim(
          {
            version: 'v1',
            now: clocks[0].now.toISOString(),
            actorAccountId: actor.accountId,
            actorSessionAuthorized: true,
            actorRestricted: false,
            participant,
            taxonomy,
          },
          {
            skillId: input.skillId,
            claimedLevel: input.claimedLevel,
            supportingReferences: input.supportingReferences,
          },
        );
        const current = await query<{
          id: string;
          revision: number;
          taxonomyId: string;
          skillDomain: string;
        }>(
          tx,
          'SELECT "id"::text,"revision","taxonomyId","skillDomain" FROM "SkillClaim" WHERE "participantId"=$1::uuid AND "accountId"=$2 AND "skillId"=$3 FOR UPDATE',
          [participant.id, actor.accountId, input.skillId],
        );
        await authorize(tx, actor);
        if (current.length > 1) fail('STORAGE_CONTRACT');
        if ((current[0]?.revision ?? 0) !== input.expectedClaimRevision)
          throw new SkillClaimContractError('REVISION_CHANGED');
        if (
          current.length &&
          (current[0].taxonomyId !== input.taxonomyId ||
            current[0].skillDomain !== prepared.skillDomain)
        )
          throw new SkillClaimContractError('HISTORY_CONFLICT');
        let claimId = current[0]?.id;
        if (!claimId) {
          const rows = await query<{ id: string }>(tx, 'SELECT gen_random_uuid()::text AS id', []);
          if (rows.length !== 1 || !z.uuid().safeParse(rows[0].id).success)
            fail('STORAGE_CONTRACT');
          claimId = rows[0].id;
        }
        const revision = input.expectedClaimRevision + 1;
        const versions = await query<{ id: string }>(
          tx,
          `INSERT INTO "SkillClaimVersion"("skillClaimId","accountId","participantId","skillId","skillDomain","taxonomyId","taxonomyVersionId","taxonomyRevision","revision","claimedLevel","supportingReferences","receiptId","actorAccountId","requestId") VALUES($1::uuid,$2,$3::uuid,$4,$5,$6,$7::uuid,$8::int,$9::int,$10,$11::jsonb,$12::uuid,$2,$13) RETURNING "id"::text`,
          [
            claimId,
            actor.accountId,
            participant.id,
            input.skillId,
            prepared.skillDomain,
            input.taxonomyId,
            catalogRows[0].currentVersionId,
            String(input.expectedTaxonomyRevision),
            String(revision),
            prepared.claimedLevel,
            JSON.stringify(prepared.supportingReferences),
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
            ? 'INSERT INTO "SkillClaim"("id","accountId","participantId","skillId","skillDomain","taxonomyId","revision","currentVersionId") VALUES($1::uuid,$2,$3::uuid,$4,$5,$6,$7::int,$8::uuid) RETURNING "id"::text'
            : 'UPDATE "SkillClaim" SET "revision"=$7::int,"currentVersionId"=$8::uuid WHERE "id"=$1::uuid AND "accountId"=$2 AND "participantId"=$3::uuid AND "skillId"=$4 AND "skillDomain"=$5 AND "taxonomyId"=$6 RETURNING "id"::text',
          [
            claimId,
            actor.accountId,
            participant.id,
            input.skillId,
            prepared.skillDomain,
            input.taxonomyId,
            String(revision),
            versionId,
          ],
        );
        if (projections.length !== 1) fail('STORAGE_CONTRACT');
        await authorize(tx, actor);
        return {
          resultRef: versionId,
          events: [
            {
              type: 'skill.claim_recorded.v1',
              aggregateId: claimId,
              aggregateVersion: revision,
              payload: { skillClaimVersionId: versionId },
              publish: false,
            },
          ],
        };
      },
    );
  } catch (error) {
    if (error instanceof CommandReceiptError && error.code === 'IDEMPOTENCY_KEY_REUSED') {
      await authorize(tx, actor);
      await canonicalParticipant(tx, actor);
    }
    throw error;
  }
  await authorize(tx, actor);
  const participant = await canonicalParticipant(tx, actor);
  const claim = await loadVersion(tx, actor, participant.id, result.resultRef);
  await authorize(tx, actor);
  return { status: result.status, claim };
}
export async function readSkillClaim(
  tx: CommandReceiptTransaction,
  actorValue: SkillClaimActor,
  skillId: string,
): Promise<SavedSkillClaim | null> {
  const actor = validActor(actorValue);
  if (!InternalId.safeParse(skillId).success) fail('INVALID_INPUT');
  await authorize(tx, actor);
  const participant = await canonicalParticipant(tx, actor);
  const rows = await query<{ currentVersionId: string }>(
    tx,
    'SELECT "currentVersionId"::text FROM "SkillClaim" WHERE "participantId"=$1::uuid AND "accountId"=$2 AND "skillId"=$3',
    [participant.id, actor.accountId, skillId],
  );
  if (rows.length > 1) fail('STORAGE_CONTRACT');
  const result = rows.length
    ? await loadVersion(tx, actor, participant.id, rows[0].currentVersionId)
    : null;
  await authorize(tx, actor);
  return result;
}
