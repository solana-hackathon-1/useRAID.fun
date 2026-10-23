import { z } from 'zod';
import { InternalId, UtcTimestamp } from '../contracts/ids';
const Timestamp = UtcTimestamp.refine(
  (s) => !s.match(/\.(\d+)Z$/)?.[1] || s.match(/\.(\d+)Z$/)![1].length <= 3,
);
const Reason = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine(
    (s) =>
      s.length <= 2000 &&
      !/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s),
  );
export const PracticeReviewPurposeSchema = z.enum(['OWNERSHIP_REVIEW', 'ASSESSMENT_REVIEW']);
export const IssuePracticeReviewAssignmentInputSchema = z
  .strictObject({
    version: z.literal('v1'),
    submissionId: z.uuid(),
    evaluatorAccountId: InternalId,
    purpose: PracticeReviewPurposeSchema,
    expiresAt: Timestamp,
    reason: Reason,
  })
  .readonly();
export const RevokePracticeReviewAssignmentInputSchema = z
  .strictObject({ version: z.literal('v1'), assignmentId: z.uuid(), reason: Reason })
  .readonly();
export const PracticeReviewAssignmentRecordSchema = z
  .strictObject({
    version: z.literal('v1'),
    id: z.uuid(),
    submissionId: z.uuid(),
    evaluatorAccountId: InternalId,
    purpose: PracticeReviewPurposeSchema,
    expiresAt: Timestamp,
    issuedAt: Timestamp,
    issuedByAccountId: InternalId,
    reason: Reason,
    state: z.literal('ISSUED'),
    isAuthorizationToken: z.literal(false),
  })
  .readonly();
export const PracticeReviewRevocationRecordSchema = z
  .strictObject({
    version: z.literal('v1'),
    id: z.uuid(),
    assignmentId: z.uuid(),
    revokedAt: Timestamp,
    revokedByAccountId: InternalId,
    reason: Reason,
    state: z.literal('REVOKED'),
    isAuthorizationToken: z.literal(false),
  })
  .readonly();
export type PracticeReviewAssignmentRecord = z.output<typeof PracticeReviewAssignmentRecordSchema>;
export type PracticeReviewRevocationRecord = z.output<typeof PracticeReviewRevocationRecordSchema>;

const Common = {
  version: z.literal('v1'),
  status: z.enum(['EXECUTED', 'REPLAYED']),
  writesAvailable: z.boolean(),
  unavailableReason: z.literal('DISABLED').nullable(),
};
const available = (v: { writesAvailable: boolean; unavailableReason: string | null }) =>
  v.writesAvailable === (v.unavailableReason === null);
export const PracticeReviewAssignmentIssueResultSchema = z
  .strictObject({ ...Common, assignment: PracticeReviewAssignmentRecordSchema })
  .refine(available)
  .readonly();
export const PracticeReviewAssignmentRevokeResultSchema = z
  .strictObject({ ...Common, revocation: PracticeReviewRevocationRecordSchema })
  .refine(available)
  .readonly();
