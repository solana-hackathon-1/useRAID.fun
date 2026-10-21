import { z } from 'zod';
import { InternalId, UtcTimestamp } from '../contracts/ids';
import { SkillRankSchema } from '../contracts/entities';
import { SkillVersionReferenceSchema } from './contracts';
import { SkillAssessmentSnapshotSchema } from './assessment-review-contracts';
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
const Timestamp = UtcTimestamp.refine((v) => (v.match(/\.(\d+)Z$/)?.[1].length ?? 0) <= 3);
const Criteria = z
  .array(
    z
      .strictObject({
        criterionId: InternalId,
        result: z.enum(['MET', 'NOT_MET', 'UNCERTAIN']),
        reason: Text,
      })
      .readonly(),
  )
  .min(1)
  .max(50)
  .refine((v) => new Set(v.map((c) => c.criterionId)).size === v.length)
  .readonly();
const Decision = z.enum(['VERIFY', 'MORE_EVIDENCE', 'NOT_DEMONSTRATED']);
export const RecordPracticeTrialAssessmentInputSchema = z
  .strictObject({
    version: z.literal('v1'),
    assignmentId: z.uuid(),
    submissionId: z.uuid(),
    expectedSubmissionReference: Reference,
    expectedDefinitionReference: Reference,
    expectedRubricReference: Reference,
    expectedPolicyReference: Reference,
    expectedOwnershipReference: Reference.nullable(),
    expectedReviewReference: Reference.nullable(),
    expectedAssessmentReference: Reference.nullable(),
    decision: Decision,
    reason: Text,
    confidenceStatement: Text,
    criteria: Criteria,
    reassessmentAt: Timestamp.nullable(),
  })
  .readonly();
export const ReadPracticeTrialAssessmentInputSchema = z
  .strictObject({
    version: z.literal('v1'),
    assignmentId: z.uuid(),
    submissionId: z.uuid(),
    revision: z.number().int().min(1).max(2147483647).optional(),
  })
  .readonly();
export const PracticeAssessmentReviewRecordSchema = z
  .strictObject({
    version: z.literal('v1'),
    id: z.uuid(),
    reference: Reference,
    submissionReference: Reference,
    participantId: z.uuid(),
    taxonomyReference: Reference,
    definitionReference: Reference,
    rubricReference: Reference,
    skillId: InternalId,
    skillDomain: InternalId,
    assignmentId: z.uuid(),
    policyVersionId: z.uuid(),
    policyReference: Reference,
    ownershipVersionId: z.uuid().nullable(),
    ownershipReference: Reference.nullable(),
    assessmentReference: Reference.nullable(),
    evaluatorAccountId: InternalId,
    decision: Decision,
    reason: Text,
    confidenceStatement: Text,
    criteria: Criteria,
    reassessmentAt: Timestamp.nullable(),
    reviewedAt: Timestamp,
    persisted: z.literal(true),
    createsVerifiedAssessment: z.boolean(),
    isAuthorizationToken: z.literal(false),
    createsPermissionGrant: z.literal(false),
    consumesCapacity: z.literal(false),
    createsFinancialObligation: z.literal(false),
  })
  .refine(
    (v) =>
      v.reference.recordId === v.submissionReference.recordId &&
      v.submissionReference.revision === 1 &&
      v.createsVerifiedAssessment === (v.decision === 'VERIFY') &&
      (v.assessmentReference !== null) === (v.decision === 'VERIFY') &&
      (v.ownershipReference === null) === (v.ownershipVersionId === null) &&
      (v.decision !== 'VERIFY' || v.ownershipReference !== null) &&
      (!v.ownershipReference || v.ownershipReference.recordId === v.submissionReference.recordId),
  )
  .readonly();
const same = (
  a: Readonly<{ recordId: string; revision: number }> | null,
  b: Readonly<{ recordId: string; revision: number }> | null,
) => (a === null || b === null ? a === b : a.recordId === b.recordId && a.revision === b.revision);
export const PracticeTrialAssessmentViewSchema = z
  .strictObject({
    version: z.literal('v1'),
    private: z.literal(true),
    review: PracticeAssessmentReviewRecordSchema,
    assessment: SkillAssessmentSnapshotSchema.nullable(),
    currentReviewReference: Reference,
    currentAssessmentReference: Reference.nullable(),
    isCurrentReview: z.boolean(),
    isCurrentAssessment: z.boolean(),
    accessId: z.uuid(),
    isAuthorizationToken: z.literal(false),
  })
  .refine(
    (v) =>
      v.currentReviewReference.recordId === v.review.reference.recordId &&
      v.currentReviewReference.revision >= v.review.reference.revision &&
      v.isCurrentReview === same(v.currentReviewReference, v.review.reference) &&
      same(v.review.assessmentReference, v.assessment?.reference ?? null) &&
      (!v.assessment ||
        (v.currentAssessmentReference !== null &&
          v.currentAssessmentReference.recordId === v.assessment.reference.recordId &&
          v.currentAssessmentReference.revision >= v.assessment.reference.revision)) &&
      v.isCurrentAssessment ===
        (v.assessment !== null && same(v.currentAssessmentReference, v.assessment.reference)) &&
      (!v.assessment ||
        (v.assessment.participantId === v.review.participantId &&
          v.assessment.skillId === v.review.skillId &&
          v.assessment.skillDomain === v.review.skillDomain &&
          same(v.assessment.submissionReference, v.review.submissionReference) &&
          same(v.assessment.definitionReference, v.review.definitionReference) &&
          same(v.assessment.rubricReference, v.review.rubricReference) &&
          v.assessment.assessmentPolicyVersion === v.review.policyVersionId &&
          v.assessment.evaluatorAccountId === v.review.evaluatorAccountId)),
  )
  .readonly();
export type PracticeAssessmentReviewRecord = z.output<typeof PracticeAssessmentReviewRecordSchema>;
export type PracticeTrialAssessmentView = z.output<typeof PracticeTrialAssessmentViewSchema>;

export const ObservePracticeTrialAssessmentContextInputSchema =
  ReadPracticeTrialAssessmentInputSchema.unwrap().omit({ revision: true }).readonly();
export const PracticeTrialAssessmentContextSchema = z
  .strictObject({
    version: z.literal('v1'),
    private: z.literal(true),
    assignmentId: z.uuid(),
    participantId: z.uuid(),
    submissionReference: Reference,
    definitionReference: Reference,
    rubricReference: Reference,
    taxonomyReference: Reference,
    skillId: InternalId,
    skillDomain: InternalId,
    targetRank: SkillRankSchema,
    evaluatorMethod: z.enum(['MANUAL', 'AUTOMATED_WITH_MANUAL_REVIEW']),
    currentOwnershipReference: Reference.nullable(),
    currentReviewReference: Reference.nullable(),
    currentAssessmentReference: Reference.nullable(),
    accessId: z.uuid(),
    verifiesSkill: z.literal(false),
    isAuthorizationToken: z.literal(false),
    createsPermissionGrant: z.literal(false),
    consumesCapacity: z.literal(false),
    createsFinancialObligation: z.literal(false),
  })
  .refine(
    (v) =>
      v.submissionReference.revision === 1 &&
      (!v.currentOwnershipReference ||
        v.currentOwnershipReference.recordId === v.submissionReference.recordId) &&
      (!v.currentReviewReference ||
        v.currentReviewReference.recordId === v.submissionReference.recordId),
  )
  .readonly();
export type PracticeTrialAssessmentContext = z.output<typeof PracticeTrialAssessmentContextSchema>;

const Findings = z
  .array(
    z
      .strictObject({
        kind: z.enum(['ASSESSMENT_EVIDENCE', 'OWNERSHIP_EVIDENCE', 'CAPABILITY_EVIDENCE']),
        detail: Text,
      })
      .readonly(),
  )
  .min(1)
  .max(20)
  .readonly();
export const RecordPracticeAssessmentDecisionInputSchema = z
  .strictObject({
    version: z.literal('v1'),
    assignmentId: z.uuid(),
    submissionId: z.uuid(),
    expectedAssessmentReference: Reference,
    expectedReviewReference: Reference,
    expectedOwnershipReference: Reference,
    expectedPolicyReference: Reference,
    action: z.enum(['REQUIRE_REASSESSMENT', 'REVOKE']),
    reasonCategory: z.enum(['CAPABILITY_RECHECK', 'FRAUDULENT_ASSESSMENT_EVIDENCE']),
    reason: Text,
    findings: Findings,
    dueAt: Timestamp.nullable(),
  })
  .refine((v) =>
    v.action === 'REVOKE'
      ? v.reasonCategory === 'FRAUDULENT_ASSESSMENT_EVIDENCE' &&
        v.dueAt === null &&
        v.findings.some((f) => f.kind === 'ASSESSMENT_EVIDENCE' || f.kind === 'OWNERSHIP_EVIDENCE')
      : v.reasonCategory === 'CAPABILITY_RECHECK' &&
        v.dueAt !== null &&
        v.findings.some((f) => f.kind === 'CAPABILITY_EVIDENCE'),
  )
  .readonly();
export const PracticeTrialAssessmentStateSchema = z
  .strictObject({
    version: z.literal('v1'),
    private: z.literal(true),
    assessment: SkillAssessmentSnapshotSchema,
    assessmentVersionId: z.uuid(),
    taxonomyId: InternalId,
    sourceReviewReference: Reference,
    currentAssessmentReference: Reference,
    isCurrent: z.boolean(),
    accessId: z.uuid(),
    isAuthorizationToken: z.literal(false),
    createsPermissionGrant: z.literal(false),
    consumesCapacity: z.literal(false),
    createsFinancialObligation: z.literal(false),
  })
  .refine(
    (v) =>
      v.currentAssessmentReference.recordId === v.assessment.reference.recordId &&
      v.currentAssessmentReference.revision >= v.assessment.reference.revision &&
      v.isCurrent === same(v.currentAssessmentReference, v.assessment.reference) &&
      v.sourceReviewReference.recordId === v.assessment.submissionReference.recordId,
  )
  .readonly();
export type PracticeTrialAssessmentState = z.output<typeof PracticeTrialAssessmentStateSchema>;

export const PracticeAssessmentDecisionRecordSchema = z
  .strictObject({
    version: z.literal('v1'),
    id: z.uuid(),
    assessmentReference: Reference,
    priorAssessmentReference: Reference,
    submissionReference: Reference,
    caseReviewReference: Reference,
    ownershipReference: Reference,
    assignmentId: z.uuid(),
    policyVersionId: z.uuid(),
    policyReference: Reference,
    evaluatorAccountId: InternalId,
    action: z.enum(['REQUIRE_REASSESSMENT', 'REVOKE']),
    reasonCategory: z.enum(['CAPABILITY_RECHECK', 'FRAUDULENT_ASSESSMENT_EVIDENCE']),
    reason: Text,
    findings: Findings,
    dueAt: Timestamp.nullable(),
    decidedAt: Timestamp,
    persisted: z.literal(true),
    isAuthorizationToken: z.literal(false),
    createsPermissionGrant: z.literal(false),
    consumesCapacity: z.literal(false),
    createsFinancialObligation: z.literal(false),
  })
  .refine(
    (v) =>
      v.assessmentReference.recordId === v.priorAssessmentReference.recordId &&
      v.assessmentReference.revision === v.priorAssessmentReference.revision + 1 &&
      v.submissionReference.revision === 1 &&
      v.caseReviewReference.recordId === v.submissionReference.recordId &&
      v.ownershipReference.recordId === v.submissionReference.recordId &&
      (v.action === 'REVOKE'
        ? v.findings.some(
            (f) => f.kind === 'ASSESSMENT_EVIDENCE' || f.kind === 'OWNERSHIP_EVIDENCE',
          )
        : v.findings.some((f) => f.kind === 'CAPABILITY_EVIDENCE')) &&
      (v.action === 'REVOKE'
        ? v.reasonCategory === 'FRAUDULENT_ASSESSMENT_EVIDENCE' && v.dueAt === null
        : v.reasonCategory === 'CAPABILITY_RECHECK' &&
          v.dueAt !== null &&
          Date.parse(v.dueAt) > Date.parse(v.decidedAt)),
  )
  .readonly();
export const PracticeAssessmentDecisionViewSchema = z
  .strictObject({
    version: z.literal('v1'),
    private: z.literal(true),
    decision: PracticeAssessmentDecisionRecordSchema,
    priorAssessment: SkillAssessmentSnapshotSchema,
    assessment: SkillAssessmentSnapshotSchema,
    currentAssessmentReference: Reference,
    isCurrent: z.boolean(),
    accessId: z.uuid(),
    isAuthorizationToken: z.literal(false),
  })
  .refine(
    (v) =>
      same(v.decision.priorAssessmentReference, v.priorAssessment.reference) &&
      same(v.decision.assessmentReference, v.assessment.reference) &&
      v.currentAssessmentReference.recordId === v.assessment.reference.recordId &&
      v.currentAssessmentReference.revision >= v.assessment.reference.revision &&
      v.isCurrent === same(v.currentAssessmentReference, v.assessment.reference) &&
      v.priorAssessment.participantId === v.assessment.participantId &&
      v.priorAssessment.skillId === v.assessment.skillId &&
      v.priorAssessment.skillDomain === v.assessment.skillDomain &&
      same(v.priorAssessment.submissionReference, v.assessment.submissionReference) &&
      same(v.assessment.submissionReference, v.decision.submissionReference) &&
      same(v.priorAssessment.definitionReference, v.assessment.definitionReference) &&
      same(v.priorAssessment.rubricReference, v.assessment.rubricReference) &&
      v.priorAssessment.evidenceReferences.length === v.assessment.evidenceReferences.length &&
      v.priorAssessment.evidenceReferences.every((r, i) =>
        same(r, v.assessment.evidenceReferences[i]),
      ) &&
      v.priorAssessment.state !== 'REVOKED' &&
      (v.decision.action === 'REVOKE' || v.priorAssessment.state === 'VERIFIED') &&
      Date.parse(v.assessment.issuedAt) >= Date.parse(v.priorAssessment.issuedAt) &&
      v.priorAssessment.assessedRank === v.assessment.assessedRank &&
      v.priorAssessment.confidenceStatement === v.assessment.confidenceStatement &&
      v.priorAssessment.sampleSize === v.assessment.sampleSize &&
      v.assessment.state ===
        (v.decision.action === 'REVOKE' ? 'REVOKED' : 'REASSESSMENT_REQUIRED') &&
      v.assessment.evaluatorAccountId === v.decision.evaluatorAccountId &&
      v.assessment.assessmentPolicyVersion === v.decision.policyVersionId &&
      v.assessment.issuedAt === v.decision.decidedAt &&
      v.assessment.reassessmentAt === v.decision.dueAt,
  )
  .readonly();
export type PracticeAssessmentDecisionView = z.output<typeof PracticeAssessmentDecisionViewSchema>;

export {
  Reference as PracticeAssessmentReferenceSchema,
  Text as PracticeAssessmentTextSchema,
  Criteria as PracticeAssessmentCriteriaSchema,
};
