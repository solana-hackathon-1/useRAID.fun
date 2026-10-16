import { z } from 'zod';
import { InternalId, ParticipantId, UtcTimestamp } from '../contracts/ids';
import {
  executeIdempotentCommand,
  canonicalRequestDigest,
  CommandReceiptError,
  type CommandReceiptTransaction,
  type SqlBinding,
} from '../command-receipts';
import { SkillVersionReferenceSchema } from './contracts';
import { PracticeTrialDefinitionSchema } from './practice-trial-contracts';
import {
  SkillTaxonomyActorSchema,
  SkillTaxonomyStorageError,
  lockSkillStorageActor,
  type SkillTaxonomyActor,
} from './taxonomy-storage';
import {
  lockPracticeTrialParticipant,
  readPracticeTrialStart,
  PracticeTrialAttemptStorageError,
} from './practice-trial-attempt-storage';
const Reference = SkillVersionReferenceSchema.unwrap()
  .extend({ revision: z.number().int().min(1).max(2147483647) })
  .readonly();
const compatible = (value: string) =>
  !/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
// Code and prose bytes remain exact; trim is used solely to reject invisible empty input.
const Text = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.length <= maximum)
    .refine((value) => value.trim().length > 0)
    .refine(compatible);
const Tools = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((value) => value.length <= 200)
      .refine(compatible),
  )
  .max(50)
  .refine((items) => new Set(items).size === items.length)
  .readonly();
export const SubmitPracticeTrialInputSchema = z
  .strictObject({
    version: z.literal('v1'),
    startId: z.uuid(),
    expectedDefinitionReference: Reference,
    expectedRubricReference: Reference,
    answer: Text(40000),
    explanation: Text(4000),
    toolsUsed: Tools,
    aiAssistanceUsed: z.boolean(),
    assistanceDisclosure: Text(4000),
  })
  .readonly();
export const PracticeTrialSubmissionRecordSchema = z
  .strictObject({
    version: z.literal('v1'),
    reference: Reference.unwrap()
      .extend({ revision: z.literal(1) })
      .readonly(),
    startId: z.uuid(),
    participantId: ParticipantId,
    skillId: InternalId,
    skillDomain: InternalId,
    definitionReference: Reference,
    rubricReference: Reference,
    state: z.literal('SUBMITTED'),
    submittedAt: UtcTimestamp,
    answer: Text(40000),
    explanation: Text(4000),
    toolsUsed: Tools,
    aiAssistanceUsed: z.boolean(),
    assistanceDisclosure: Text(4000),
    ownership: z.literal('UNCONFIRMED'),
    persisted: z.literal(true),
    verifiesSkill: z.literal(false),
    isAuthorizationToken: z.literal(false),
    createsPermissionGrant: z.literal(false),
    consumesCapacity: z.literal(false),
    createsFinancialObligation: z.literal(false),
  })
  .readonly();
export type PracticeTrialSubmissionRecord = z.output<typeof PracticeTrialSubmissionRecordSchema>;
export interface SubmitPracticeTrialCommand {
  readonly actor: SkillTaxonomyActor;
  readonly input: unknown;
  readonly idempotencyKey: string;
  readonly requestId: string;
}
export class PracticeTrialSubmissionStorageError extends Error {
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'AUTHENTICATION_REQUIRED'
      | 'ACCOUNT_RESTRICTED'
      | 'FORBIDDEN'
      | 'RESOURCE_UNAVAILABLE'
      | 'REVISION_CHANGED'
      | 'ALREADY_SUBMITTED'
      | 'WRITES_DISABLED'
      | 'STORAGE_CONTRACT'
      | 'STORAGE_UNAVAILABLE',
  ) {
    super(code);
    this.name = 'PracticeTrialSubmissionStorageError';
  }
}
function fail(code: PracticeTrialSubmissionStorageError['code']): never {
  throw new PracticeTrialSubmissionStorageError(code);
}
function actorValid(value: unknown) {
  const result = SkillTaxonomyActorSchema.safeParse(value);
  if (!result.success) fail('INVALID_INPUT');
  return result.data;
}
function normalize(error: unknown): never {
  if (
    error instanceof SkillTaxonomyStorageError ||
    error instanceof PracticeTrialAttemptStorageError
  ) {
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
async function owner(tx: CommandReceiptTransaction, actor: SkillTaxonomyActor) {
  try {
    return await lockPracticeTrialParticipant(tx, actor);
  } catch (error) {
    return normalize(error);
  }
}
async function acceptedStart(tx: CommandReceiptTransaction, actor: SkillTaxonomyActor, id: string) {
  try {
    const result = await readPracticeTrialStart(tx, actor, id);
    if (!result) fail('RESOURCE_UNAVAILABLE');
    return result;
  } catch (error) {
    return normalize(error);
  }
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
    if (
      error instanceof CommandReceiptError ||
      error instanceof PracticeTrialSubmissionStorageError
    )
      throw error;
    return fail('STORAGE_UNAVAILABLE');
  }
}
async function load(
  tx: CommandReceiptTransaction,
  actor: SkillTaxonomyActor,
  participantId: string,
  id: string,
): Promise<PracticeTrialSubmissionRecord | null> {
  const rows = await query<{
    id: string;
    revision: number;
    startId: string;
    participantId: string;
    definition: unknown;
    submittedAt: Date;
    answer: string;
    explanation: string;
    toolsUsed: unknown;
    aiAssistanceUsed: boolean;
    assistanceDisclosure: string;
  }>(
    tx,
    'SELECT s."id"::text,s."revision",s."startId"::text,s."participantId"::text,d."definition",s."submittedAt",s."answer",s."explanation",s."toolsUsed",s."aiAssistanceUsed",s."assistanceDisclosure" FROM "PracticeTrialSubmission" s JOIN "PracticeTrialStart" a ON a."id"=s."startId" JOIN "PracticeTrialVersion" d ON d."id"=a."definitionVersionId" WHERE s."id"=$1::uuid AND s."accountId"=$2 AND s."participantId"=$3::uuid',
    [id, actor.accountId, participantId],
  );
  if (rows.length > 1) fail('STORAGE_CONTRACT');
  if (!rows.length) return null;
  const r = rows[0];
  if (
    !(r.submittedAt instanceof Date) ||
    Number.isNaN(r.submittedAt.getTime()) ||
    !r.definition ||
    typeof r.definition !== 'object'
  )
    fail('STORAGE_CONTRACT');
  const original = PracticeTrialDefinitionSchema.safeParse(r.definition);
  if (
    !original.success ||
    canonicalRequestDigest(original.data) !== canonicalRequestDigest(r.definition)
  )
    fail('STORAGE_CONTRACT');
  const parsed = PracticeTrialSubmissionRecordSchema.safeParse({
    version: 'v1',
    reference: { recordId: r.id, revision: r.revision },
    startId: r.startId,
    participantId: r.participantId,
    skillId: original.data.skillId,
    skillDomain: original.data.skillDomain,
    definitionReference: original.data.reference,
    rubricReference: original.data.rubric.reference,
    state: 'SUBMITTED',
    submittedAt: r.submittedAt.toISOString(),
    answer: r.answer,
    explanation: r.explanation,
    toolsUsed: r.toolsUsed,
    aiAssistanceUsed: r.aiAssistanceUsed,
    assistanceDisclosure: r.assistanceDisclosure,
    ownership: 'UNCONFIRMED',
    persisted: true,
    verifiesSkill: false,
    isAuthorizationToken: false,
    createsPermissionGrant: false,
    consumesCapacity: false,
    createsFinancialObligation: false,
  });
  if (
    !parsed.success ||
    canonicalRequestDigest(parsed.data.toolsUsed) !== canonicalRequestDigest(r.toolsUsed)
  )
    fail('STORAGE_CONTRACT');
  return parsed.data;
}
function same(
  a: { recordId: string; revision: number },
  b: { recordId: string; revision: number },
) {
  return a.recordId === b.recordId && a.revision === b.revision;
}
/** Receipt→current canonical owner→immutable accepted start→submission mutex; no external effects. */
export async function submitPracticeTrial(
  tx: CommandReceiptTransaction,
  command: SubmitPracticeTrialCommand,
  options: { readonly allowNewWrites: boolean; readonly canSubmit?: () => boolean },
): Promise<{ status: 'EXECUTED' | 'REPLAYED'; submission: PracticeTrialSubmissionRecord }> {
  const actor = actorValid(command?.actor);
  if (
    typeof options?.allowNewWrites !== 'boolean' ||
    (options.canSubmit !== undefined && typeof options.canSubmit !== 'function')
  )
    fail('STORAGE_CONTRACT');
  const parsed = SubmitPracticeTrialInputSchema.safeParse(command.input);
  if (!parsed.success) fail('INVALID_INPUT');
  const input = parsed.data;
  let result;
  try {
    result = await executeIdempotentCommand(
      tx,
      {
        actorId: actor.accountId,
        commandKind: 'SubmitPracticeTrial',
        idempotencyKey: command.idempotencyKey,
        requestId: command.requestId,
        request: input,
      },
      async ({ receiptId }) => {
        await lockSkillStorageActor(tx, actor);
        if (!options.allowNewWrites) fail('WRITES_DISABLED');
        const checkScope = () => {
          if (options.canSubmit === undefined) return;
          try {
            if (options.canSubmit() === true) return;
          } catch {
            /* Fail closed. */
          }
          fail('RESOURCE_UNAVAILABLE');
        };
        checkScope();
        const participant = await owner(tx, actor),
          start = await acceptedStart(tx, actor, input.startId);
        if (start.participantId !== participant.id) fail('STORAGE_CONTRACT');
        if (
          !same(input.expectedDefinitionReference, start.definition.reference) ||
          !same(input.expectedRubricReference, start.definition.rubric.reference)
        )
          fail('REVISION_CHANGED');
        const locked = await query<{ id: string }>(
          tx,
          'SELECT "id"::text FROM "PracticeTrialStart" WHERE "id"=$1::uuid AND "accountId"=$2 AND "participantId"=$3::uuid FOR SHARE',
          [input.startId, actor.accountId, participant.id],
        );
        if (locked.length !== 1) fail('STORAGE_CONTRACT');
        await owner(tx, actor);
        await query(tx, 'SELECT pg_advisory_xact_lock(hashtextextended($1,12016))::text', [
          input.startId,
        ]);
        await owner(tx, actor);
        const prior = await query(
          tx,
          'SELECT "id"::text FROM "PracticeTrialSubmission" WHERE "startId"=$1::uuid',
          [input.startId],
        );
        if (prior.length) fail('ALREADY_SUBMITTED');
        const [clock] = await query<{ now: Date; id: string }>(
          tx,
          "SELECT date_trunc('milliseconds',clock_timestamp()) AS now,gen_random_uuid()::text AS id",
          [],
        );
        if (
          !clock ||
          !(clock.now instanceof Date) ||
          Number.isNaN(clock.now.getTime()) ||
          !z.uuid().safeParse(clock.id).success ||
          clock.now.getTime() < Date.parse(start.startedAt)
        )
          fail('STORAGE_CONTRACT');
        checkScope();
        const inserted = await query<{ id: string }>(
          tx,
          'INSERT INTO "PracticeTrialSubmission"("id","startId","participantId","accountId","answer","explanation","toolsUsed","aiAssistanceUsed","assistanceDisclosure","submittedAt","receiptId","requestId") VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::jsonb,$8::boolean,$9,$10::timestamptz,$11::uuid,$12) RETURNING "id"::text',
          [
            clock.id,
            input.startId,
            participant.id,
            actor.accountId,
            input.answer,
            input.explanation,
            JSON.stringify(input.toolsUsed),
            String(input.aiAssistanceUsed),
            input.assistanceDisclosure,
            clock.now.toISOString(),
            receiptId,
            command.requestId,
          ],
        );
        if (inserted.length !== 1 || inserted[0].id !== clock.id) fail('STORAGE_CONTRACT');
        await owner(tx, actor);
        checkScope();
        return {
          resultRef: clock.id,
          events: [
            {
              type: 'skill.practice_trial_submitted.v1',
              aggregateId: clock.id,
              aggregateVersion: 1,
              payload: { practiceTrialSubmissionId: clock.id },
              publish: false,
            },
          ],
        };
      },
    );
  } catch (error) {
    if (error instanceof CommandReceiptError && error.code === 'IDEMPOTENCY_KEY_REUSED')
      await owner(tx, actor);
    normalize(error);
  }
  const participant = await owner(tx, actor),
    submission = await load(tx, actor, participant.id, result.resultRef);
  if (!submission) fail('STORAGE_CONTRACT');
  await owner(tx, actor);
  return { status: result.status, submission };
}
/** Current canonical owner only; missing and foreign IDs return the same null result. */
export async function readPracticeTrialSubmission(
  tx: CommandReceiptTransaction,
  actorValue: SkillTaxonomyActor,
  id: string,
): Promise<PracticeTrialSubmissionRecord | null> {
  const actor = actorValid(actorValue);
  if (!z.uuid().safeParse(id).success) fail('INVALID_INPUT');
  const participant = await owner(tx, actor),
    submission = await load(tx, actor, participant.id, id);
  await owner(tx, actor);
  return submission;
}
