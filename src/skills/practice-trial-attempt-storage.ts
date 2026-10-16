import { z } from 'zod';
import { ParticipantId, UtcTimestamp } from '../contracts/ids';
import { ParticipantSchema } from '../contracts/entities';
import {
  canonicalRequestDigest,
  executeIdempotentCommand,
  CommandReceiptError,
  type CommandReceiptTransaction,
  type SqlBinding,
} from '../command-receipts';
import { SkillVersionReferenceSchema } from './contracts';
import {
  PracticeTrialAttemptInputSchema,
  PracticeTrialDefinitionSchema,
  PracticeTrialContractError,
} from './practice-trial-contracts';
import { preparePracticeTrialAttempt } from './practice-trials';
import { readPracticeTrialDefinition, PracticeTrialStorageError } from './practice-trial-storage';
import {
  lockSkillStorageActor,
  readPublishedSkillTaxonomy,
  SkillTaxonomyStorageError,
  SkillTaxonomyActorSchema,
  type SkillTaxonomyActor,
} from './taxonomy-storage';
const Reference = SkillVersionReferenceSchema.unwrap()
  .extend({ revision: z.number().int().min(1).max(2147483647) })
  .readonly();
export const StartPracticeTrialInputSchema = PracticeTrialAttemptInputSchema.superRefine(
  (value, ctx) => {
    if (
      value.definitionReference.revision > 2147483647 ||
      (value.accommodationReference && value.accommodationReference.revision > 2147483647)
    )
      ctx.addIssue({ code: 'custom', message: 'Stored revision exceeds INTEGER.' });
  },
).readonly();
/** Immutable start history, not an assertion that an attempt is currently active or submitted. */
export const PracticeTrialStartRecordSchema = z
  .strictObject({
    version: z.literal('v1'),
    id: z.uuid(),
    state: z.literal('STARTED'),
    participantId: ParticipantId,
    definition: PracticeTrialDefinitionSchema,
    taxonomyReference: Reference,
    accommodationReference: z.null(),
    attemptNumber: z.number().int().min(1).max(10000),
    startedAt: UtcTimestamp,
    persisted: z.literal(true),
    verifiesSkill: z.literal(false),
    isAuthorizationToken: z.literal(false),
    createsPermissionGrant: z.literal(false),
    consumesCapacity: z.literal(false),
    createsFinancialObligation: z.literal(false),
  })
  .readonly();
export type PracticeTrialStartRecord = z.output<typeof PracticeTrialStartRecordSchema>;
export interface StartPracticeTrialCommand {
  readonly actor: SkillTaxonomyActor;
  readonly input: unknown;
  readonly idempotencyKey: string;
  readonly requestId: string;
}
export class PracticeTrialAttemptStorageError extends Error {
  constructor(
    readonly code:
      | PracticeTrialContractError['code']
      | SkillTaxonomyStorageError['code']
      | 'WRITES_DISABLED'
      | 'STORAGE_CONTRACT'
      | 'STORAGE_UNAVAILABLE',
  ) {
    super(code);
    this.name = 'PracticeTrialAttemptStorageError';
  }
}
function fail(code: PracticeTrialAttemptStorageError['code']): never {
  throw new PracticeTrialAttemptStorageError(code);
}
function actorValid(value: unknown) {
  const parsed = SkillTaxonomyActorSchema.safeParse(value);
  if (!parsed.success) fail('INVALID_INPUT');
  return parsed.data;
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
    if (error instanceof CommandReceiptError || error instanceof PracticeTrialAttemptStorageError)
      throw error;
    return fail('STORAGE_UNAVAILABLE');
  }
}
async function authorize(tx: CommandReceiptTransaction, actor: SkillTaxonomyActor) {
  try {
    await lockSkillStorageActor(tx, actor);
  } catch (error) {
    if (error instanceof SkillTaxonomyStorageError) fail(error.code);
    throw error;
  }
}
async function participantFor(tx: CommandReceiptTransaction, actor: SkillTaxonomyActor) {
  const rows = await query(
    tx,
    'SELECT "id"::text,"kind","accountId" FROM "Participant" WHERE "accountId"=$1 FOR SHARE',
    [actor.accountId],
  );
  if (!rows.length) fail('RESOURCE_UNAVAILABLE');
  const parsed = ParticipantSchema.safeParse(rows[0]);
  if (
    rows.length !== 1 ||
    !parsed.success ||
    parsed.data.kind !== 'HUMAN' ||
    parsed.data.accountId !== actor.accountId ||
    !z.uuid().safeParse(parsed.data.id).success
  )
    fail('STORAGE_CONTRACT');
  await authorize(tx, actor);
  return parsed.data;
}
async function load(
  tx: CommandReceiptTransaction,
  actor: SkillTaxonomyActor,
  participantId: string,
  id: string,
): Promise<PracticeTrialStartRecord | null> {
  const rows = await query<{
    id: string;
    participantId: string;
    definition: unknown;
    taxonomyId: string;
    taxonomyRevision: number;
    attemptNumber: number;
    startedAt: Date;
  }>(
    tx,
    'SELECT s."id"::text,s."participantId"::text,v."definition",s."taxonomyId",s."taxonomyRevision",s."attemptNumber",s."startedAt" FROM "PracticeTrialStart" s JOIN "PracticeTrialVersion" v ON v."id"=s."definitionVersionId" WHERE s."id"=$1::uuid AND s."accountId"=$2 AND s."participantId"=$3::uuid',
    [id, actor.accountId, participantId],
  );
  if (rows.length > 1) fail('STORAGE_CONTRACT');
  if (!rows.length) return null;
  const r = rows[0];
  if (!(r.startedAt instanceof Date) || Number.isNaN(r.startedAt.getTime()))
    fail('STORAGE_CONTRACT');
  const parsed = PracticeTrialStartRecordSchema.safeParse({
    version: 'v1',
    id: r.id,
    state: 'STARTED',
    participantId: r.participantId,
    definition: r.definition,
    taxonomyReference: { recordId: r.taxonomyId, revision: r.taxonomyRevision },
    accommodationReference: null,
    attemptNumber: r.attemptNumber,
    startedAt: r.startedAt.toISOString(),
    persisted: true,
    verifiesSkill: false,
    isAuthorizationToken: false,
    createsPermissionGrant: false,
    consumesCapacity: false,
    createsFinancialObligation: false,
  });
  if (
    !parsed.success ||
    canonicalRequestDigest(parsed.data.definition) !== canonicalRequestDigest(r.definition)
  )
    fail('STORAGE_CONTRACT');
  return parsed.data;
}
/** Receipt→User→Session→Participant→catalog→trial→family history; the host commits promptly. */
export async function startPracticeTrial(
  tx: CommandReceiptTransaction,
  command: StartPracticeTrialCommand,
  options: {
    readonly allowNewWrites: boolean;
    readonly canStart?: (
      scope: Readonly<{
        accountId: string;
        participantId: string;
        taxonomyId: string;
        skillId: string;
        skillDomain: string;
      }>,
    ) => boolean;
  },
): Promise<{ status: 'EXECUTED' | 'REPLAYED'; start: PracticeTrialStartRecord }> {
  const actor = actorValid(command?.actor);
  if (
    typeof options?.allowNewWrites !== 'boolean' ||
    (options.canStart !== undefined && typeof options.canStart !== 'function')
  )
    fail('STORAGE_CONTRACT');
  const parsed = StartPracticeTrialInputSchema.safeParse(command.input);
  if (!parsed.success) fail('INVALID_INPUT');
  const input = parsed.data;
  let result;
  try {
    result = await executeIdempotentCommand(
      tx,
      {
        actorId: actor.accountId,
        commandKind: 'StartPracticeTrial',
        idempotencyKey: command.idempotencyKey,
        requestId: command.requestId,
        request: input,
      },
      async ({ receiptId }) => {
        await authorize(tx, actor);
        if (!options.allowNewWrites) fail('WRITES_DISABLED');
        const participant = await participantFor(tx, actor);
        if (input.accommodationReference !== null) fail('ACCOMMODATION_UNAVAILABLE');
        const trialId = input.definitionReference.recordId;
        const families = await query<{ taxonomyId: string }>(
          tx,
          'SELECT "taxonomyId" FROM "PracticeTrial" WHERE "id"=$1',
          [trialId],
        );
        if (!families.length) fail('RESOURCE_UNAVAILABLE');
        if (families.length !== 1) fail('STORAGE_CONTRACT');
        const taxonomyId = families[0].taxonomyId;
        await query(tx, 'SELECT pg_advisory_xact_lock(hashtextextended($1,12012))::text', [
          taxonomyId,
        ]);
        const catalogs = await query<{ currentVersionId: string; revision: number }>(
          tx,
          'SELECT "currentVersionId"::text,"revision" FROM "SkillTaxonomy" WHERE "id"=$1 FOR SHARE',
          [taxonomyId],
        );
        await authorize(tx, actor);
        if (catalogs.length !== 1) fail('STORAGE_CONTRACT');
        await query(tx, 'SELECT pg_advisory_xact_lock(hashtextextended($1,12013))::text', [
          trialId,
        ]);
        const trials = await query<{ currentVersionId: string; revision: number }>(
          tx,
          'SELECT "currentVersionId"::text,"revision" FROM "PracticeTrial" WHERE "id"=$1 FOR SHARE',
          [trialId],
        );
        await authorize(tx, actor);
        if (trials.length !== 1) fail('STORAGE_CONTRACT');
        if (trials[0].revision !== input.definitionReference.revision) fail('REVISION_CHANGED');
        const saved = await readPracticeTrialDefinition(tx, actor, trialId);
        if (!saved || saved.definition.reference.revision !== trials[0].revision)
          fail('STORAGE_CONTRACT');
        if (saved.availability !== 'AVAILABLE') fail('DEFINITION_UNAVAILABLE');
        const taxonomy = await readPublishedSkillTaxonomy(tx, actor, taxonomyId);
        if (!taxonomy || taxonomy.revision !== catalogs[0].revision) fail('STORAGE_CONTRACT');
        const startScope = Object.freeze({
          accountId: actor.accountId,
          participantId: participant.id,
          taxonomyId: taxonomy.id,
          skillId: saved.definition.skillId,
          skillDomain: saved.definition.skillDomain,
        });
        const checkScope = () => {
          if (options.canStart === undefined) return;
          try {
            if (options.canStart(startScope) === true) return;
          } catch {
            /* Host policy failure denies new intent. */
          }
          fail('RESOURCE_UNAVAILABLE');
        };
        checkScope();
        await query(tx, 'SELECT pg_advisory_xact_lock(hashtextextended($1,12015))::text', [
          participant.id + ':' + trialId,
        ]);
        await authorize(tx, actor);
        const [history] = await query<{ used: number; lastAt: Date | null }>(
          tx,
          'SELECT count(*)::int AS used,max("startedAt") AS "lastAt" FROM "PracticeTrialStart" WHERE "participantId"=$1::uuid AND "trialId"=$2',
          [participant.id, trialId],
        );
        const [clock] = await query<{ now: Date; id: string }>(
          tx,
          "SELECT date_trunc('milliseconds',clock_timestamp()) AS now,gen_random_uuid()::text AS id",
          [],
        );
        if (
          !history ||
          !Number.isInteger(history.used) ||
          history.used < 0 ||
          history.used > 10000 ||
          (history.lastAt !== null && !(history.lastAt instanceof Date)) ||
          !clock ||
          !(clock.now instanceof Date) ||
          Number.isNaN(clock.now.getTime()) ||
          !z.uuid().safeParse(clock.id).success
        )
          fail('STORAGE_CONTRACT');
        let prepared;
        try {
          prepared = preparePracticeTrialAttempt(
            {
              version: 'v1',
              now: clock.now.toISOString(),
              actorAccountId: actor.accountId,
              actorSessionAuthorized: true,
              actorRestricted: false,
              participant,
              taxonomy,
              definition: saved.definition,
              attemptHistory: {
                status: 'CURRENT',
                participantId: participant.id,
                trialId,
                observedAt: clock.now.toISOString(),
                validUntil: new Date(clock.now.getTime() + 1).toISOString(),
                attemptsUsed: history.used,
                lastAttemptAt: history.lastAt?.toISOString() ?? null,
              },
              accommodation: null,
            },
            input,
            {
              isApprovedDefinition: (candidate: z.output<typeof PracticeTrialDefinitionSchema>) =>
                canonicalRequestDigest(candidate) === canonicalRequestDigest(saved.definition),
              isApprovedAccommodation: () => false,
            },
          );
        } catch (error) {
          if (error instanceof PracticeTrialContractError)
            fail(
              error.code === 'INVALID_HOST_CONTRACT' || error.code === 'HOST_POLICY_UNAVAILABLE'
                ? 'STORAGE_CONTRACT'
                : error.code,
            );
          throw error;
        }
        checkScope();
        const inserted = await query<{ id: string }>(
          tx,
          'INSERT INTO "PracticeTrialStart"("id","participantId","accountId","trialId","definitionVersionId","taxonomyId","taxonomyRevision","taxonomyVersionId","attemptNumber","startedAt","receiptId","requestId") VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,$6,$7::int,$8::uuid,$9::int,$10::timestamptz,$11::uuid,$12) RETURNING "id"::text',
          [
            clock.id,
            participant.id,
            actor.accountId,
            trialId,
            trials[0].currentVersionId,
            taxonomy.id,
            String(taxonomy.revision),
            catalogs[0].currentVersionId,
            String(prepared.attemptNumber),
            prepared.preparedAt,
            receiptId,
            command.requestId,
          ],
        );
        if (inserted.length !== 1 || inserted[0].id !== clock.id) fail('STORAGE_CONTRACT');
        await authorize(tx, actor);
        checkScope();
        return {
          resultRef: clock.id,
          events: [
            {
              type: 'skill.practice_trial_started.v1',
              aggregateId: clock.id,
              aggregateVersion: 1,
              payload: { practiceTrialStartId: clock.id },
              publish: false,
            },
          ],
        };
      },
    );
  } catch (error) {
    if (error instanceof CommandReceiptError && error.code === 'IDEMPOTENCY_KEY_REUSED') {
      await authorize(tx, actor);
      await participantFor(tx, actor);
    }
    if (error instanceof SkillTaxonomyStorageError) fail(error.code);
    if (error instanceof PracticeTrialStorageError) {
      switch (error.code) {
        case 'INVALID_INPUT':
        case 'AUTHENTICATION_REQUIRED':
        case 'ACCOUNT_RESTRICTED':
        case 'FORBIDDEN':
        case 'RESOURCE_UNAVAILABLE':
        case 'STORAGE_CONTRACT':
        case 'STORAGE_UNAVAILABLE':
          fail(error.code);
        default:
          fail('STORAGE_CONTRACT');
      }
    }
    throw error;
  }
  await authorize(tx, actor);
  const participant = await participantFor(tx, actor);
  const start = await load(tx, actor, participant.id, result.resultRef);
  if (!start) fail('STORAGE_CONTRACT');
  await authorize(tx, actor);
  return { status: result.status, start };
}
/** Private own canonical start history; unknown/foreign IDs do not disclose records. */
export async function readPracticeTrialStart(
  tx: CommandReceiptTransaction,
  actorValue: SkillTaxonomyActor,
  id: string,
): Promise<PracticeTrialStartRecord | null> {
  const actor = actorValid(actorValue);
  if (!z.uuid().safeParse(id).success) fail('INVALID_INPUT');
  await authorize(tx, actor);
  const participant = await participantFor(tx, actor);
  const start = await load(tx, actor, participant.id, id);
  await authorize(tx, actor);
  return start;
}
/** Current locked own canonical HUMAN only; not an authorization token. */
export async function lockPracticeTrialParticipant(
  _tx: CommandReceiptTransaction,
  _actorValue: SkillTaxonomyActor,
): Promise<Readonly<Extract<z.output<typeof ParticipantSchema>, { kind: 'HUMAN' }>>> {
  const actor = actorValid(_actorValue);
  await authorize(_tx, actor);
  return Object.freeze(await participantFor(_tx, actor));
}
