import { z } from 'zod';
import {
  RecordPracticeTrialAssessmentInputSchema,
  RecordPracticeAssessmentDecisionInputSchema,
  PracticeTrialAssessmentViewSchema,
  PracticeTrialAssessmentStateSchema,
  PracticeAssessmentDecisionViewSchema,
} from './practice-trial-assessment-contracts';
function invalid(): never {
  throw new Error('INVALID_RESULT');
}
const ReadEnvelope = z.strictObject({
  version: z.literal('v1'),
  readsAvailable: z.boolean(),
  unavailableReason: z.literal('DISABLED').nullable(),
});
const WriteEnvelope = z.strictObject({
  version: z.literal('v1'),
  status: z.enum(['EXECUTED', 'REPLAYED']),
  readsAvailable: z.boolean(),
  writesAvailable: z.boolean(),
  unavailableReason: z.enum(['DISABLED', 'MISCONFIGURED']).nullable(),
});
const readable = (r: { readsAvailable: boolean; unavailableReason: unknown; view: unknown }) =>
  r.readsAvailable === (r.unavailableReason === null) && (r.readsAvailable || r.view === null);
const written = (r: {
  readsAvailable: boolean;
  writesAvailable: boolean;
  unavailableReason: unknown;
  view: unknown;
}) =>
  r.writesAvailable === (r.unavailableReason === null) && r.readsAvailable === (r.view !== null);
export const PracticeAssessmentReviewReadResultSchema = ReadEnvelope.extend({
  view: PracticeTrialAssessmentViewSchema.nullable(),
}).refine(readable);
export const PracticeAssessmentStateReadResultSchema = ReadEnvelope.extend({
  view: PracticeTrialAssessmentStateSchema.nullable(),
}).refine(readable);
export const PracticeAssessmentDecisionReadResultSchema = ReadEnvelope.extend({
  view: PracticeAssessmentDecisionViewSchema.nullable(),
}).refine(readable);
export const PracticeAssessmentReviewWriteResultSchema = WriteEnvelope.extend({
  view: PracticeTrialAssessmentViewSchema.nullable(),
}).refine(written);
export const PracticeAssessmentDecisionWriteResultSchema = WriteEnvelope.extend({
  view: PracticeAssessmentDecisionViewSchema.nullable(),
}).refine(written);
const same = (
  a: Readonly<{ recordId: string; revision: number }> | null,
  b: Readonly<{ recordId: string; revision: number }> | null,
) => (a === null || b === null ? a === b : a.recordId === b.recordId && a.revision === b.revision);

export function parsePracticeAssessmentReviewWriteResult(
  value: unknown,
  input: z.output<typeof RecordPracticeTrialAssessmentInputSchema>,
  accountId: string,
) {
  const parsed = PracticeAssessmentReviewWriteResultSchema.safeParse(value);
  if (!parsed.success) invalid();
  const result = parsed.data,
    view = result.view;
  if (view) {
    const r = view.review,
      a = view.assessment;
    if (
      r.assignmentId !== input.assignmentId ||
      r.evaluatorAccountId !== accountId ||
      r.reference.recordId !== input.submissionId ||
      r.reference.revision !== (input.expectedReviewReference?.revision ?? 0) + 1 ||
      !same(r.submissionReference, input.expectedSubmissionReference) ||
      !same(r.definitionReference, input.expectedDefinitionReference) ||
      !same(r.rubricReference, input.expectedRubricReference) ||
      !same(r.policyReference, input.expectedPolicyReference) ||
      !same(r.ownershipReference, input.expectedOwnershipReference) ||
      r.decision !== input.decision ||
      r.reason !== input.reason ||
      r.confidenceStatement !== input.confidenceStatement ||
      r.reassessmentAt !== input.reassessmentAt ||
      JSON.stringify(r.criteria) !== JSON.stringify(input.criteria) ||
      (result.status === 'EXECUTED' && !view.isCurrentReview) ||
      (a &&
        (a.state !== 'VERIFIED' ||
          a.sampleSize !== 1 ||
          a.confidenceStatement !== input.confidenceStatement ||
          a.reassessmentAt !== input.reassessmentAt ||
          a.issuedAt !== r.reviewedAt ||
          a.reference.revision !== (input.expectedAssessmentReference?.revision ?? 0) + 1 ||
          (input.expectedAssessmentReference !== null &&
            a.reference.recordId !== input.expectedAssessmentReference.recordId) ||
          (result.status === 'EXECUTED' && !view.isCurrentAssessment))) ||
      (!a &&
        !same(view.currentAssessmentReference, input.expectedAssessmentReference) &&
        result.status === 'EXECUTED')
    )
      invalid();
  }
  return result;
}
export function parsePracticeAssessmentDecisionWriteResult(
  value: unknown,
  input: z.output<typeof RecordPracticeAssessmentDecisionInputSchema>,
  accountId: string,
) {
  const parsed = PracticeAssessmentDecisionWriteResultSchema.safeParse(value);
  if (!parsed.success) invalid();
  const result = parsed.data,
    view = result.view;
  if (view) {
    const d = view.decision;
    if (
      d.assignmentId !== input.assignmentId ||
      d.evaluatorAccountId !== accountId ||
      d.submissionReference.recordId !== input.submissionId ||
      !same(d.priorAssessmentReference, input.expectedAssessmentReference) ||
      !same(d.caseReviewReference, input.expectedReviewReference) ||
      !same(d.ownershipReference, input.expectedOwnershipReference) ||
      !same(d.policyReference, input.expectedPolicyReference) ||
      d.action !== input.action ||
      d.reasonCategory !== input.reasonCategory ||
      d.reason !== input.reason ||
      d.dueAt !== input.dueAt ||
      JSON.stringify(d.findings) !== JSON.stringify(input.findings) ||
      (result.status === 'EXECUTED' && !view.isCurrent)
    )
      invalid();
  }
  return result;
}
