import { z } from 'zod';
import { AccountId, InternalId, ParticipantId, UtcTimestamp } from '../contracts/ids';
import { ParticipantSchema, SkillRankSchema } from '../contracts/entities';
import { PublishedSkillTaxonomySchema, SkillVersionReferenceSchema } from './contracts';
import {
  PracticeTrialDefinitionSchema,
  type PracticeTrialDefinition,
} from './practice-trial-contracts';

const Timestamp = UtcTimestamp.refine((value) => {
  const fraction = value.match(/\.(\d+)Z$/)?.[1];
  return !fraction || fraction.length <= 3;
});
const Reason = z.string().trim().min(1).max(2000);
const EvidenceReferences = z
  .array(SkillVersionReferenceSchema)
  .min(1)
  .max(50)
  .refine((items) => new Set(items.map((item) => item.recordId)).size === items.length)
  .readonly();
/** Actual immutable committed record supplied by an authorized host, never a proposal. */
export const SkillAssessmentSnapshotSchema = z
  .strictObject({
    version: z.literal('v1'),
    reference: SkillVersionReferenceSchema,
    participantId: ParticipantId,
    skillId: InternalId,
    skillDomain: InternalId,
    state: z.enum(['VERIFIED', 'REASSESSMENT_REQUIRED', 'REVOKED']),
    assessedRank: SkillRankSchema,
    definitionReference: SkillVersionReferenceSchema,
    rubricReference: SkillVersionReferenceSchema,
    submissionReference: SkillVersionReferenceSchema,
    evidenceReferences: EvidenceReferences,
    assessmentPolicyVersion: InternalId,
    evaluatorAccountId: AccountId,
    issuedAt: Timestamp,
    reassessmentAt: Timestamp.nullable(),
    confidenceStatement: Reason,
    sampleSize: z.number().int().min(1).max(1000000),
  })
  .readonly();
const Observation = z.discriminatedUnion('status', [
  z
    .strictObject({
      status: z.literal('CURRENT'),
      participantId: ParticipantId,
      skillId: InternalId,
      observedAt: Timestamp,
      validUntil: Timestamp,
      record: SkillAssessmentSnapshotSchema.nullable(),
    })
    .readonly(),
  z.strictObject({ status: z.literal('STALE') }).readonly(),
  z.strictObject({ status: z.literal('UNAVAILABLE') }).readonly(),
]);
const Common = z.strictObject({
  version: z.literal('v1'),
  now: Timestamp,
  actorAccountId: AccountId.nullable(),
  actorSessionAuthorized: z.boolean(),
  actorRestricted: z.boolean(),
  subject: ParticipantSchema.readonly(),
  taxonomy: PublishedSkillTaxonomySchema,
  assessmentRecordId: InternalId,
  assessmentPolicyVersion: InternalId,
  assessmentObservation: Observation,
});
export const SkillAssessmentReviewContextSchema = Common.extend({
  definition: PracticeTrialDefinitionSchema,
  submission: z
    .strictObject({
      version: z.literal('v1'),
      reference: SkillVersionReferenceSchema,
      participantId: ParticipantId,
      definitionReference: SkillVersionReferenceSchema,
      state: z.literal('SUBMITTED'),
      submittedAt: Timestamp,
      observedAt: Timestamp,
      validUntil: Timestamp,
      evidenceReferences: EvidenceReferences,
      ownership: z.enum(['CONFIRMED', 'UNCONFIRMED', 'DISPUTED']),
      sampleSize: z.number().int().min(1).max(1000000),
    })
    .readonly(),
}).readonly();
export const SkillAssessmentReviewInputSchema = z
  .strictObject({
    version: z.literal('v1'),
    expectedDefinitionReference: SkillVersionReferenceSchema,
    expectedRubricReference: SkillVersionReferenceSchema,
    expectedSubmissionReference: SkillVersionReferenceSchema,
    expectedAssessmentReference: SkillVersionReferenceSchema.nullable(),
    decision: z.enum(['VERIFY', 'MORE_EVIDENCE', 'NOT_DEMONSTRATED']),
    reason: Reason,
    confidenceStatement: Reason,
    criteria: z
      .array(
        z
          .strictObject({
            criterionId: InternalId,
            result: z.enum(['MET', 'NOT_MET', 'UNCERTAIN']),
            reason: Reason,
          })
          .readonly(),
      )
      .min(1)
      .max(50)
      .refine((items) => new Set(items.map((item) => item.criterionId)).size === items.length)
      .readonly(),
    reassessmentAt: Timestamp.nullable(),
  })
  .readonly();
export const SkillAssessmentReassessmentContextSchema = Common.extend({
  caseEvidence: z.discriminatedUnion('status', [
    z
      .strictObject({
        status: z.literal('CURRENT'),
        participantId: ParticipantId,
        assessmentReference: SkillVersionReferenceSchema,
        observedAt: Timestamp,
        validUntil: Timestamp,
        evidenceReferences: EvidenceReferences,
      })
      .readonly(),
    z.strictObject({ status: z.literal('STALE') }).readonly(),
    z.strictObject({ status: z.literal('UNAVAILABLE') }).readonly(),
  ]),
}).readonly();
const ReassessmentInput = z.strictObject({
  version: z.literal('v1'),
  expectedAssessmentReference: SkillVersionReferenceSchema,
  reason: Reason,
});
export const SkillAssessmentReassessmentInputSchema = z.discriminatedUnion('action', [
  ReassessmentInput.extend({
    action: z.literal('REQUIRE_REASSESSMENT'),
    reasonCategory: z.literal('CAPABILITY_RECHECK'),
    dueAt: Timestamp,
  }).readonly(),
  ReassessmentInput.extend({
    action: z.literal('REVOKE'),
    reasonCategory: z.literal('FRAUDULENT_ASSESSMENT_EVIDENCE'),
  }).readonly(),
]);
export type SkillAssessmentReviewContext = z.output<typeof SkillAssessmentReviewContextSchema>;
export type SkillAssessmentReviewInput = z.output<typeof SkillAssessmentReviewInputSchema>;
export type SkillAssessmentReassessmentContext = z.output<
  typeof SkillAssessmentReassessmentContextSchema
>;
export type SkillAssessmentReassessmentInput = z.output<
  typeof SkillAssessmentReassessmentInputSchema
>;
/** Current scoped authority/pass conditions and full historical approved definition are host facts. */
export interface SkillAssessmentReviewPolicy {
  isApprovedDefinition(definition: PracticeTrialDefinition, now: string): boolean;
  canPrepareReview(
    context: SkillAssessmentReviewContext,
    input: SkillAssessmentReviewInput,
  ): boolean;
  canPrepareReassessment(
    context: SkillAssessmentReassessmentContext,
    input: SkillAssessmentReassessmentInput,
  ): boolean;
}
export const SkillAssessmentReviewPolicySchema = z.custom<SkillAssessmentReviewPolicy>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    'isApprovedDefinition' in value &&
    typeof value.isApprovedDefinition === 'function' &&
    'canPrepareReview' in value &&
    typeof value.canPrepareReview === 'function' &&
    'canPrepareReassessment' in value &&
    typeof value.canPrepareReassessment === 'function',
);
export class SkillAssessmentReviewContractError extends Error {
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'INVALID_HOST_CONTRACT'
      | 'HOST_POLICY_UNAVAILABLE'
      | 'AUTHENTICATION_REQUIRED'
      | 'ACCOUNT_RESTRICTED'
      | 'SELF_REVIEW_FORBIDDEN'
      | 'FORBIDDEN'
      | 'RESOURCE_UNAVAILABLE'
      | 'DEFINITION_UNAVAILABLE'
      | 'ASSESSMENT_UNAVAILABLE'
      | 'SUBMISSION_UNAVAILABLE'
      | 'CASE_EVIDENCE_UNAVAILABLE'
      | 'REVISION_CHANGED'
      | 'REVISION_EXHAUSTED'
      | 'EVIDENCE_NOT_CONFIRMED'
      | 'RUBRIC_NOT_MET'
      | 'STATE_CONFLICT',
  ) {
    super(code);
    this.name = 'SkillAssessmentReviewContractError';
  }
}
