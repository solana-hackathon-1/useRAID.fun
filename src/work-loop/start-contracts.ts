import { z } from 'zod';
import type { CommandReceiptTransaction } from '../command-receipts';
import type { RaidTerms } from './terms';

/**
 * Starting work (blueprint §10.2 step 6–7, §12.2): the accepted engagement begins only after its exact funding
 * binding is verified and the resources its terms need are ready. The host supplies both answers; neither is a flag
 * from the caller.
 */
export interface StartHost {
  allowNewWrites: boolean;
  /** The exact reservation for this slot, version and reward vector is still held (simulated in this milestone). */
  verifyBinding(
    tx: CommandReceiptTransaction,
    binding: {
      engagementId: string;
      slotId: string;
      termsVersionId: string;
      fundingRef: string;
      terms: RaidTerms;
    },
  ): Promise<boolean>;
  /** Every resource the accepted terms require is provisioned and effective. None exist for public work. */
  resourcesReady(
    tx: CommandReceiptTransaction,
    context: { engagementId: string; terms: RaidTerms },
  ): Promise<boolean>;
}
export const StartEngagementInput = z.strictObject({ engagementId: z.uuid() });
export const StartedEngagementSchema = z.strictObject({
  id: z.uuid(),
  state: z.literal('IN_PROGRESS'),
  revision: z.number().int().min(2),
});
export const StartResultSchema = z.strictObject({
  status: z.enum(['EXECUTED', 'REPLAYED']),
  engagement: StartedEngagementSchema,
});
export type StartResult = z.infer<typeof StartResultSchema>;
