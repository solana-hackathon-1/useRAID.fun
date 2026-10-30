import { z } from 'zod';
import {
  canonicalRequestDigest,
  executeIdempotentCommand,
  CommandReceiptError,
  type CommandReceiptTransaction,
  type SqlBinding,
} from '../command-receipts';
import { SkillTaxonomyActorSchema, type SkillTaxonomyActor } from './taxonomy-storage';
import { PracticeTrialDefinitionSchema } from './practice-trial-contracts';
import { PracticeTrialSubmissionRecordSchema } from './practice-trial-submission-storage';
import {
  lockPracticeReviewAssignment,
  PracticeReviewAssignmentError,
  PracticeReviewAssignmentRecordSchema,
  PracticeReviewPurposeSchema,
  type PracticeReviewAssignmentUseScope,
} from './practice-review-assignment-storage';
export const ReadPracticeReviewInputSchema = z
  .strictObject({
    version: z.literal('v1'),
    assignmentId: z.uuid(),
    submissionId: z.uuid(),
    purpose: PracticeReviewPurposeSchema,
  })
  .readonly();
export type ReadPracticeReviewInput = z.output<typeof ReadPracticeReviewInputSchema>;
export const PracticeReviewReadRecordSchema = z
  .strictObject({
    version: z.literal('v1'),
    private: z.literal(true),
    accessId: z.uuid(),
    assignment: PracticeReviewAssignmentRecordSchema,
    definition: PracticeTrialDefinitionSchema,
    submission: PracticeTrialSubmissionRecordSchema,
    isAuthorizationToken: z.literal(false),
  })
  .refine((value) => {
    const same = (
      a: { recordId: string; revision: number },
      b: { recordId: string; revision: number },
    ) => a.recordId === b.recordId && a.revision === b.revision;
    return (
      value.assignment.submissionId === value.submission.reference.recordId &&
      same(value.definition.reference, value.submission.definitionReference) &&
      same(value.definition.rubric.reference, value.submission.rubricReference) &&
      value.definition.skillId === value.submission.skillId &&
      value.definition.skillDomain === value.submission.skillDomain
    );
  }, 'Private review references do not match.')
  .readonly();
export type PracticeReviewReadRecord = z.output<typeof PracticeReviewReadRecordSchema>;
export class PracticeReviewReadError extends Error {
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'AUTHENTICATION_REQUIRED'
      | 'ACCOUNT_RESTRICTED'
      | 'FORBIDDEN'
      | 'RESOURCE_UNAVAILABLE'
      | 'STORAGE_CONTRACT'
      | 'STORAGE_UNAVAILABLE',
  ) {
    super(code);
    this.name = 'PracticeReviewReadError';
  }
}
function fail(code: PracticeReviewReadError['code']): never {
  throw new PracticeReviewReadError(code);
}
async function query<R>(
  tx: CommandReceiptTransaction,
  sql: string,
  bindings: readonly SqlBinding[],
): Promise<R[]> {
  if (
    tx?.dialect !== 'POSTGRESQL' ||
    tx?.isolation !== 'READ_COMMITTED' ||
    typeof tx.query !== 'function'
  )
    fail('STORAGE_CONTRACT');
  try {
    const rows = await tx.query<R>(sql, bindings);
    if (!Array.isArray(rows)) fail('STORAGE_CONTRACT');
    return rows;
  } catch (error) {
    if (error instanceof CommandReceiptError || error instanceof PracticeReviewReadError)
      throw error;
    return fail('STORAGE_UNAVAILABLE');
  }
}
async function permission(
  tx: CommandReceiptTransaction,
  actor: SkillTaxonomyActor,
  input: ReadPracticeReviewInput,
  canRead: (scope: PracticeReviewAssignmentUseScope) => boolean,
) {
  try {
    return await lockPracticeReviewAssignment(
      tx,
      actor,
      {
        assignmentId: input.assignmentId,
        submissionId: input.submissionId,
        purpose: input.purpose,
      },
      canRead,
    );
  } catch (error) {
    if (error instanceof PracticeReviewAssignmentError) {
      switch (error.code) {
        case 'INVALID_INPUT':
        case 'AUTHENTICATION_REQUIRED':
        case 'ACCOUNT_RESTRICTED':
        case 'FORBIDDEN':
        case 'RESOURCE_UNAVAILABLE':
        case 'STORAGE_CONTRACT':
        case 'STORAGE_UNAVAILABLE':
          return fail(error.code);
        default:
          return fail('STORAGE_CONTRACT');
      }
    }
    if (error instanceof CommandReceiptError) throw error;
    return fail('STORAGE_UNAVAILABLE');
  }
}
/** Shared reviewer-read authority (current assignment, purpose and scope); sibling advisory reads reuse it. */
export { permission as lockPracticeReviewReadPermission };
/** Same held transaction: current grant before private columns and again before returning any bytes. */
export async function readPracticeTrialForReview(
  tx: CommandReceiptTransaction,
  actorValue: SkillTaxonomyActor,
  inputValue: unknown,
  canRead: (scope: PracticeReviewAssignmentUseScope) => boolean,
): Promise<PracticeReviewReadRecord | null> {
  const actor = SkillTaxonomyActorSchema.safeParse(actorValue),
    input = ReadPracticeReviewInputSchema.safeParse(inputValue);
  if (!actor.success || !input.success) fail('INVALID_INPUT');
  if (typeof canRead !== 'function') fail('STORAGE_CONTRACT');
  const assignment = await permission(tx, actor.data, input.data, canRead);
  if (!assignment) return null;
  // Every authorized attempt has its own server-generated trace; callers cannot reuse audit keys.
  // This audit means authorized access was attempted, never that a body was delivered.
  const identities = await query<{ id: string }>(tx, 'SELECT gen_random_uuid()::text AS id', []);
  if (identities.length !== 1 || !z.uuid().safeParse(identities[0].id).success)
    fail('STORAGE_CONTRACT');
  const accessId = identities[0].id;
  await executeIdempotentCommand(
    tx,
    {
      actorId: actor.data.accountId,
      commandKind: 'ReadPracticeTrialForReview',
      idempotencyKey: accessId,
      requestId: accessId,
      request: input.data,
    },
    async () => ({
      resultRef: assignment.submissionId,
      events: [
        {
          type: 'skill.practice_review_access_authorized.v1',
          aggregateId: assignment.submissionId,
          aggregateVersion: 1,
          payload: { practiceReviewAssignmentId: assignment.id },
          publish: false,
        },
      ],
    }),
  );
  // Audit persistence may wait; current authority is required again before any private selection.
  if (!(await permission(tx, actor.data, input.data, canRead))) return null;
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
    'SELECT s."id"::text,s."revision",s."startId"::text,s."participantId"::text,d."definition",s."submittedAt",s."answer",s."explanation",s."toolsUsed",s."aiAssistanceUsed",s."assistanceDisclosure" FROM "PracticeTrialSubmission" s JOIN "PracticeTrialStart" a ON a."id"=s."startId" AND a."participantId"=s."participantId" AND a."accountId"=s."accountId" JOIN "PracticeTrialVersion" d ON d."id"=a."definitionVersionId" WHERE s."id"=$1::uuid',
    [assignment.submissionId],
  );
  if (rows.length !== 1) fail('STORAGE_CONTRACT');
  const r = rows[0];
  if (!(r.submittedAt instanceof Date) || Number.isNaN(r.submittedAt.getTime()))
    fail('STORAGE_CONTRACT');
  const original = PracticeTrialDefinitionSchema.safeParse(r.definition);
  if (
    !original.success ||
    canonicalRequestDigest(original.data) !== canonicalRequestDigest(r.definition)
  )
    fail('STORAGE_CONTRACT');
  const parsed = PracticeReviewReadRecordSchema.safeParse({
    version: 'v1',
    private: true,
    accessId,
    assignment,
    definition: original.data,
    submission: {
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
    },
    isAuthorizationToken: false,
  });
  if (
    !parsed.success ||
    canonicalRequestDigest(parsed.data.submission.toolsUsed) !==
      canonicalRequestDigest(r.toolsUsed) ||
    r.id !== assignment.submissionId
  )
    fail('STORAGE_CONTRACT');
  const current = await permission(tx, actor.data, input.data, canRead);
  if (!current) return null;
  if (canonicalRequestDigest(current) !== canonicalRequestDigest(assignment))
    fail('STORAGE_CONTRACT');
  return parsed.data;
}
