import { z } from 'zod';
import { RaidTermsSchema } from './terms';
/** Replacement is a new Raid slot with its own terms and reservation; it never edits or reopens the closed attempt. */
export const ReissueRaidInput = z.strictObject({
  /** The terminated engagement being replaced. */
  engagementId: z.uuid(),
  terms: RaidTermsSchema,
});
export const ReissuedRaidSchema = z.strictObject({
  status: z.enum(['EXECUTED', 'REPLAYED']),
  listingId: z.uuid(),
  termsVersionId: z.uuid(),
  slotId: z.uuid(),
  replacesEngagementId: z.uuid(),
  fundingMode: z.literal('SIMULATED'),
});
export type ReissuedRaid = z.infer<typeof ReissuedRaidSchema>;
