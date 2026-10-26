import { z } from 'zod';
import { UtcTimestamp } from '../contracts/ids';
import { AmountSchema, AssetPolicySnapshotSchema } from '../contracts/assets';
import type { CommandReceiptTransaction } from '../command-receipts';
import type { WorkActor } from './contracts';
export interface ClosureHost {
  allowNewWrites: boolean;
  /** Current operations authority for this engagement's Guild, rechecked by the host in this transaction. */
  authorize(
    tx: CommandReceiptTransaction,
    actor: WorkActor,
    target: { engagementId: string; guildId: string },
  ): Promise<boolean>;
}
export const CloseOverdueInput = z.strictObject({
  engagementId: z.uuid(),
  /** Revision the scheduler observed; a stale job cannot close work that has since moved on. */
  expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
export const ClosureSchema = z.strictObject({
  engagementId: z.uuid(),
  finalState: z.enum(['ACCEPTED', 'TERMINATED']),
  reason: z.enum([
    'ACCEPTED',
    'ACCESS_TIMEOUT',
    'SUBMISSION_TIMEOUT',
    'REVIEW_TIMEOUT',
    'REVISION_TIMEOUT',
  ]),
  /** Closing the work duty never settles, refunds or forfeits funds. */
  financialResolution: z.literal('OPEN'),
  closedAt: UtcTimestamp,
});
export const ClaimSchema = z.strictObject({
  policy: AssetPolicySnapshotSchema,
  amount: AmountSchema,
  beneficiaryParticipantId: z.uuid(),
  /** No settlement exists in this milestone, so every preserved claim is unsettled. */
  status: z.literal('UNSETTLED'),
});
export const CloseResultSchema = z.strictObject({
  status: z.enum(['EXECUTED', 'REPLAYED']),
  closure: ClosureSchema,
});
export const OwnClosureSchema = z.strictObject({
  closure: ClosureSchema,
  claims: z.array(ClaimSchema).min(1).max(10),
});
export type OwnClosure = z.infer<typeof OwnClosureSchema>;
