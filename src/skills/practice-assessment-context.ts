import { z } from 'zod';
import {
  readPracticeTrialForReview,
  ReadPracticeReviewInputSchema,
  PracticeReviewReadRecordSchema,
} from './practice-review-read-storage';
import {
  observeApprovedPracticeReviewPolicy,
  PracticeReviewPolicyViewSchema,
} from './practice-review-policy-storage';
import { readPracticeTrialOwnership } from './practice-trial-ownership-storage';
import { PracticeTrialOwnershipViewSchema } from './practice-trial-ownership-contracts';
import {
  observePracticeTrialAssessmentContext,
  readPracticeTrialAssessment,
  readPracticeTrialAssessmentState,
  PracticeTrialAssessmentError,
} from './practice-trial-assessment-storage';
import {
  PracticeTrialAssessmentContextSchema,
  PracticeTrialAssessmentViewSchema,
  PracticeTrialAssessmentStateSchema,
} from './practice-trial-assessment-contracts';
import { lockPracticeReviewAssignment } from './practice-review-assignment-storage';
import type { SkillTaxonomyActor } from './taxonomy-storage-contracts';
import type { CommandReceiptTransaction } from '../command-receipts';
const same = (
  a: { recordId: string; revision: number } | null,
  b: { recordId: string; revision: number } | null,
) => (a === null || b === null ? a === b : a.recordId === b.recordId && a.revision === b.revision);
export const PracticeAssessmentContextSchema = z
  .strictObject({
    version: z.literal('v1'),
    review: PracticeReviewReadRecordSchema,
    policy: PracticeReviewPolicyViewSchema.nullable(),
    ownership: PracticeTrialOwnershipViewSchema.nullable(),
    references: PracticeTrialAssessmentContextSchema,
    assessmentReview: PracticeTrialAssessmentViewSchema.nullable(),
    assessmentState: PracticeTrialAssessmentStateSchema.nullable(),
  })
  .refine((c) => {
    const r = c.review,
      p = c.policy?.policy,
      o = c.ownership,
      refs = c.references,
      a = c.assessmentReview,
      s = c.assessmentState;
    return (
      r.assignment.purpose === 'ASSESSMENT_REVIEW' &&
      refs.assignmentId === r.assignment.id &&
      refs.participantId === r.submission.participantId &&
      same(refs.submissionReference, r.submission.reference) &&
      same(refs.definitionReference, r.definition.reference) &&
      same(refs.rubricReference, r.definition.rubric.reference) &&
      refs.skillId === r.definition.skillId &&
      refs.skillDomain === r.definition.skillDomain &&
      refs.targetRank === r.definition.targetRank &&
      refs.evaluatorMethod === r.definition.evaluatorMethod &&
      (!p ||
        (p.state === 'APPROVED' &&
          p.purpose === 'ASSESSMENT_REVIEW' &&
          same(p.definitionReference, r.definition.reference) &&
          same(p.rubricReference, r.definition.rubric.reference) &&
          p.skillId === r.definition.skillId &&
          p.skillDomain === r.definition.skillDomain &&
          p.targetRank === r.definition.targetRank)) &&
      same(refs.currentOwnershipReference, o?.record.reference ?? null) &&
      (!o ||
        (o.isCurrent &&
          same(o.record.submissionReference, r.submission.reference) &&
          same(o.record.definitionReference, r.definition.reference) &&
          same(o.record.rubricReference, r.definition.rubric.reference) &&
          o.record.participantId === r.submission.participantId &&
          o.record.skillId === r.definition.skillId &&
          o.record.skillDomain === r.definition.skillDomain)) &&
      same(refs.currentReviewReference, a?.review.reference ?? null) &&
      (!a ||
        (a.isCurrentReview &&
          same(a.review.submissionReference, r.submission.reference) &&
          same(a.review.definitionReference, r.definition.reference) &&
          same(a.review.rubricReference, r.definition.rubric.reference) &&
          a.review.participantId === r.submission.participantId &&
          a.review.skillId === r.definition.skillId &&
          a.review.skillDomain === r.definition.skillDomain &&
          same(a.currentAssessmentReference, refs.currentAssessmentReference))) &&
      (!s ||
        (s.isCurrent &&
          same(s.assessment.reference, refs.currentAssessmentReference) &&
          same(s.assessment.submissionReference, r.submission.reference) &&
          same(s.assessment.definitionReference, r.definition.reference) &&
          same(s.assessment.rubricReference, r.definition.rubric.reference) &&
          s.assessment.participantId === r.submission.participantId &&
          s.assessment.skillId === r.definition.skillId &&
          s.assessment.skillDomain === r.definition.skillDomain &&
          s.taxonomyId === refs.taxonomyReference.recordId))
    );
  })
  .readonly();
export type PracticeAssessmentContext = z.output<typeof PracticeAssessmentContextSchema> & {
  readonly reviewWritesAvailable: boolean;
  readonly decisionWritesAvailable: boolean;
};
/** Canonical sources share one transaction; policy scope precedes case/participant-skill locks. */
export async function readPracticeAssessmentContext(
  tx: CommandReceiptTransaction,
  actor: SkillTaxonomyActor,
  inputValue: unknown,
  enabled: () => boolean,
) {
  const p = ReadPracticeReviewInputSchema.safeParse(inputValue);
  if (!p.success || p.data.purpose !== 'ASSESSMENT_REVIEW')
    throw new PracticeTrialAssessmentError('INVALID_INPUT');
  const input = p.data;
  const review = await readPracticeTrialForReview(tx, actor, input, enabled);
  if (!review) return null;
  const policy = await observeApprovedPracticeReviewPolicy(tx, actor, input, enabled);
  const ownership = await readPracticeTrialOwnership(tx, actor, input, enabled);
  const readInput = {
    version: 'v1' as const,
    assignmentId: input.assignmentId,
    submissionId: input.submissionId,
  };
  const references = await observePracticeTrialAssessmentContext(tx, actor, readInput, enabled);
  if (!references) return null;
  const assessmentReview = await readPracticeTrialAssessment(tx, actor, readInput, enabled);
  const assessmentState = await readPracticeTrialAssessmentState(tx, actor, readInput, enabled);
  const finalGrant = await lockPracticeReviewAssignment(
    tx,
    actor,
    { assignmentId: input.assignmentId, submissionId: input.submissionId, purpose: input.purpose },
    enabled,
  );
  if (!finalGrant || !enabled()) return null;
  const result = PracticeAssessmentContextSchema.safeParse({
    version: 'v1',
    review,
    policy,
    ownership,
    references,
    assessmentReview,
    assessmentState,
  });
  if (
    !result.success ||
    review.assignment.id !== input.assignmentId ||
    review.submission.reference.recordId !== input.submissionId ||
    review.assignment.evaluatorAccountId !== actor.accountId
  )
    throw new PracticeTrialAssessmentError('STORAGE_CONTRACT');
  return result.data;
}
