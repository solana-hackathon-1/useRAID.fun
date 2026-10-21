import { z } from 'zod';
import { InternalId, UtcTimestamp } from '../contracts/ids';
import { SkillVersionReferenceSchema } from './contracts';
const Reference = SkillVersionReferenceSchema.unwrap()
  .extend({ revision: z.number().int().min(1).max(2147483647) })
  .readonly();
const Text = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine(
    (s) =>
      s.length <= 2000 &&
      !/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s),
  );
const Observations = z
  .array(
    z
      .strictObject({
        kind: z.enum(['EXPLANATION', 'MODIFICATION', 'ATTRIBUTION', 'OTHER']),
        detail: Text,
      })
      .readonly(),
  )
  .min(1)
  .max(20)
  .readonly();
const Decision = z.enum(['CONFIRM', 'DISPUTE', 'MORE_EVIDENCE']);
const purpose = z.enum(['OWNERSHIP_REVIEW', 'ASSESSMENT_REVIEW']);
export const RecordPracticeTrialOwnershipInputSchema = z
  .strictObject({
    version: z.literal('v1'),
    assignmentId: z.uuid(),
    submissionId: z.uuid(),
    expectedSubmissionReference: Reference,
    expectedDefinitionReference: Reference,
    expectedRubricReference: Reference,
    expectedPolicyReference: Reference,
    expectedOwnershipReference: Reference.nullable(),
    decision: Decision,
    reason: Text,
    observations: Observations,
  })
  .readonly();
export const ReadPracticeTrialOwnershipInputSchema = z
  .strictObject({
    version: z.literal('v1'),
    assignmentId: z.uuid(),
    submissionId: z.uuid(),
    purpose,
    revision: z.number().int().min(1).max(2147483647).optional(),
  })
  .readonly();
export const PracticeTrialOwnershipRecordSchema = z
  .strictObject({
    version: z.literal('v1'),
    id: z.uuid(),
    reference: Reference,
    submissionReference: Reference,
    participantId: z.uuid(),
    definitionReference: Reference,
    rubricReference: Reference,
    skillId: InternalId,
    skillDomain: InternalId,
    assignmentId: z.uuid(),
    policyVersionId: z.uuid(),
    policyReference: Reference,
    evaluatorAccountId: InternalId,
    decision: Decision,
    ownership: z.enum(['CONFIRMED', 'DISPUTED', 'UNCONFIRMED']),
    reason: Text,
    observations: Observations,
    caseAccessId: z.uuid(),
    policyAccessId: z.uuid(),
    reviewedAt: UtcTimestamp,
    persisted: z.literal(true),
    verifiesSkill: z.literal(false),
    isAuthorizationToken: z.literal(false),
    createsPermissionGrant: z.literal(false),
    consumesCapacity: z.literal(false),
    createsFinancialObligation: z.literal(false),
  })
  .refine(
    (v) =>
      v.reference.recordId === v.submissionReference.recordId &&
      v.submissionReference.revision === 1 &&
      v.ownership ===
        (v.decision === 'CONFIRM'
          ? 'CONFIRMED'
          : v.decision === 'DISPUTE'
            ? 'DISPUTED'
            : 'UNCONFIRMED'),
  )
  .readonly();
export const PracticeTrialOwnershipViewSchema = z
  .strictObject({
    version: z.literal('v1'),
    private: z.literal(true),
    record: PracticeTrialOwnershipRecordSchema,
    currentReference: Reference,
    isCurrent: z.boolean(),
    accessId: z.uuid(),
    isAuthorizationToken: z.literal(false),
  })
  .refine(
    (v) =>
      v.currentReference.recordId === v.record.reference.recordId &&
      v.currentReference.revision >= v.record.reference.revision &&
      v.isCurrent === (v.currentReference.revision === v.record.reference.revision),
  )
  .readonly();
export type PracticeTrialOwnershipRecord = z.output<typeof PracticeTrialOwnershipRecordSchema>;
export type PracticeTrialOwnershipView = z.output<typeof PracticeTrialOwnershipViewSchema>;

export { Decision as PracticeOwnershipDecisionSchema };
