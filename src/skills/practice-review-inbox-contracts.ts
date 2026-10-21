import { z } from 'zod';
import { InternalId, UtcTimestamp } from '../contracts/ids';
export const PracticeReviewInboxInputSchema = z.strictObject({
  version: z.literal('v1'),
  after: z.uuid().toLowerCase().nullable(),
});
export const PracticeReviewInboxEntrySchema = z.strictObject({
  assignmentId: z.uuid(),
  submissionId: z.uuid(),
  purpose: z.enum(['OWNERSHIP_REVIEW', 'ASSESSMENT_REVIEW']),
  issuedAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
});
export const PracticeReviewInboxPageSchema = z
  .strictObject({
    version: z.literal('v1'),
    private: z.literal(true),
    isAuthorizationToken: z.literal(false),
    accessId: z.uuid(),
    observedAt: UtcTimestamp,
    entries: z.array(PracticeReviewInboxEntrySchema).max(20),
    nextCursor: z.uuid().nullable(),
  })
  .refine((page) => {
    const now = Date.parse(page.observedAt);
    return (
      page.entries.every(
        (entry, i) =>
          Date.parse(entry.issuedAt) <= now &&
          Date.parse(entry.expiresAt) > now &&
          (i === 0 || page.entries[i - 1].assignmentId < entry.assignmentId),
      ) &&
      (page.nextCursor === null ||
        (page.entries.length === 20 && page.nextCursor === page.entries.at(-1)?.assignmentId))
    );
  });
/** Internal host binding; omit account identity from the wire/view. */
export const PracticeReviewInboxHostResultSchema = z.strictObject({
  accountId: InternalId,
  page: PracticeReviewInboxPageSchema,
});
export type PracticeReviewInboxInput = z.infer<typeof PracticeReviewInboxInputSchema>;
export type PracticeReviewInboxPage = z.infer<typeof PracticeReviewInboxPageSchema>;
