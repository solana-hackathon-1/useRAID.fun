import { z } from 'zod';
import { UtcTimestamp } from '../contracts/ids';
const text = z.string().trim().min(1).max(8000);
/** Explicit host policy. Reviewer authority comes from the accepted terms, never from host flags. */
export interface SubmissionHost {
  allowNewWrites: boolean;
}
/** A reference plus the immutable version reviewed: checksum, provider commit id or artifact version. */
export const ArtifactSchema = z.strictObject({
  kind: z.enum(['URL_SNAPSHOT', 'COMMIT', 'PRIVATE_ARTIFACT']),
  ref: z.string().trim().min(1).max(500),
  immutableVersion: z.string().trim().min(1).max(200),
});
export const SubmitWorkInput = z
  .strictObject({
    engagementId: z.uuid(),
    expectedSubmissionNumber: z.number().int().min(1).max(11),
    explanation: text,
    artifacts: z.array(ArtifactSchema).min(1).max(20),
    dependencies: z.array(text).max(50),
    aiUsage: text.nullable(),
  })
  .refine(
    (v) =>
      new Set(v.artifacts.map((a) => a.ref + '\n' + a.immutableVersion)).size ===
      v.artifacts.length,
    {
      message: 'Duplicate artifact version.',
    },
  );
export const CriterionResultSchema = z.strictObject({
  index: z.number().int().min(0).max(49),
  result: z.enum(['MET', 'UNMET']),
  evidence: z.string().trim().min(1).max(2000).nullable(),
});
export const DecideReviewInput = z
  .strictObject({
    submissionId: z.uuid(),
    decision: z.enum(['ACCEPT', 'REQUEST_REVISION', 'DISPUTE']),
    reason: text,
    criteria: z.array(CriterionResultSchema).min(1).max(50),
    revisionDeadline: UtcTimestamp.nullable(),
  })
  .superRefine((v, ctx) => {
    const unmet = v.criteria.some((c) => c.result === 'UNMET');
    const problem =
      new Set(v.criteria.map((c) => c.index)).size !== v.criteria.length
        ? 'Each criterion is reviewed once.'
        : v.decision === 'ACCEPT' && (unmet || v.revisionDeadline !== null)
          ? 'Acceptance requires every criterion met and no revision deadline.'
          : v.decision === 'REQUEST_REVISION' && (!unmet || v.revisionDeadline === null)
            ? 'A revision names an unmet original criterion and a finite deadline.'
            : v.decision === 'DISPUTE' && (!unmet || v.revisionDeadline !== null)
              ? 'A dispute names an unmet original criterion and has no revision deadline.'
              : null;
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });
export const SubmissionSchema = z.strictObject({
  id: z.uuid(),
  engagementId: z.uuid(),
  termsVersionId: z.uuid(),
  submissionNumber: z.number().int().min(1),
  submitterParticipantId: z.uuid(),
  explanation: text,
  artifacts: z.array(ArtifactSchema).min(1).max(20),
  dependencies: z.array(text).max(50),
  aiUsage: text.nullable(),
  createdAt: UtcTimestamp,
});
export const ReviewSchema = z.strictObject({
  id: z.uuid(),
  submissionId: z.uuid(),
  engagementId: z.uuid(),
  termsVersionId: z.uuid(),
  decision: z.enum(['ACCEPT', 'REQUEST_REVISION', 'DISPUTE']),
  reason: text,
  criteria: z.array(CriterionResultSchema).min(1).max(50),
  revisionDeadline: UtcTimestamp.nullable(),
  createdAt: UtcTimestamp,
});
const EngagementState = z.enum([
  'ACCESS_PENDING',
  'IN_PROGRESS',
  'SUBMITTED',
  'UNDER_REVIEW',
  'REVISION_REQUESTED',
  'ACCEPTED',
  'WITHDRAWN',
  'CANCELLED',
  'TERMINATED',
]);
export const SubmissionResultSchema = z.strictObject({
  status: z.enum(['EXECUTED', 'REPLAYED']),
  engagementState: EngagementState,
  submission: SubmissionSchema,
});
export const ReviewResultSchema = z.strictObject({
  status: z.enum(['EXECUTED', 'REPLAYED']),
  engagementState: EngagementState,
  review: ReviewSchema,
});
export type SubmissionResult = z.infer<typeof SubmissionResultSchema>;
export type ReviewResult = z.infer<typeof ReviewResultSchema>;
