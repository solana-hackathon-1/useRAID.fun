import { z } from 'zod';
import { InternalId, UtcTimestamp } from '../contracts/ids';
import {
  PracticeReviewAssignmentRecordSchema,
  PracticeReviewRevocationRecordSchema,
} from './practice-review-assignment-contracts';
export const PracticeAssignmentManagementInputSchema = z
  .strictObject({
    version: z.literal('v1'),
    submissionId: z.uuid().toLowerCase().nullable(),
    after: z.uuid().toLowerCase().nullable(),
  })
  .refine((v) => v.submissionId !== null || v.after === null);
export const PracticeAssignmentManagementEntrySchema = z.strictObject({
  assignment: PracticeReviewAssignmentRecordSchema,
  revocation: PracticeReviewRevocationRecordSchema.nullable(),
  currentState: z.enum(['ACTIVE', 'EXPIRED', 'REVOKED']),
});
export const PracticeAssignmentManagementPageSchema = z
  .strictObject({
    version: z.literal('v1'),
    private: z.literal(true),
    isAuthorizationToken: z.literal(false),
    accessId: z.uuid(),
    actorAccountId: InternalId,
    observedAt: UtcTimestamp,
    submissionId: z.uuid().nullable(),
    after: z.uuid().nullable(),
    entries: z.array(PracticeAssignmentManagementEntrySchema).max(20),
    nextCursor: z.uuid().nullable(),
  })
  .refine((p) => {
    const now = Date.parse(p.observedAt);
    return (
      (p.submissionId !== null ||
        (p.entries.length === 0 && p.after === null && p.nextCursor === null)) &&
      p.entries.every(
        (e, i) =>
          e.assignment.submissionId === p.submissionId &&
          Date.parse(e.assignment.issuedAt) <= now &&
          (i === 0 || p.entries[i - 1].assignment.id < e.assignment.id) &&
          (p.after === null || e.assignment.id > p.after) &&
          (e.revocation
            ? e.currentState === 'REVOKED' &&
              e.revocation.assignmentId === e.assignment.id &&
              Date.parse(e.revocation.revokedAt) <= now &&
              Date.parse(e.revocation.revokedAt) >= Date.parse(e.assignment.issuedAt)
            : e.currentState === (Date.parse(e.assignment.expiresAt) > now ? 'ACTIVE' : 'EXPIRED')),
      ) &&
      (p.nextCursor === null ||
        (p.entries.length === 20 && p.nextCursor === p.entries.at(-1)?.assignment.id))
    );
  });
export const PracticeAssignmentManagementResultSchema = z
  .strictObject({
    version: z.literal('v1'),
    writesAvailable: z.boolean(),
    unavailableReason: z.literal('DISABLED').nullable(),
    page: PracticeAssignmentManagementPageSchema,
  })
  .refine((v) => v.writesAvailable === (v.unavailableReason === null));
export type PracticeAssignmentManagementInput = z.infer<
  typeof PracticeAssignmentManagementInputSchema
>;
export type PracticeAssignmentManagementPage = z.infer<
  typeof PracticeAssignmentManagementPageSchema
>;
export type PracticeAssignmentManagementContext = z.infer<
  typeof PracticeAssignmentManagementResultSchema
>;
