import { z } from 'zod';
import { UtcTimestamp } from '../contracts/ids';
import { TermsSnapshotSchema } from '../contracts/entities';
import { AmountSchema, AssetPolicySnapshotSchema } from '../contracts/assets';
import { fromJsonAmount } from '../asset-registry/amounts';
import type { CommandReceiptTransaction } from '../command-receipts';
import type { WorkActor } from './contracts';
/** One reward leg's added obligation. Shown to the host so it can reserve exactly this much. */
export interface RewardIncrease {
  policy: z.infer<typeof AssetPolicySnapshotSchema>;
  amount: string;
}
export interface AmendmentHost {
  allowNewWrites: boolean;
  /** Current scoped Founder authority over this engagement's source, rechecked by the host in this transaction.
   * At the member's consent the proposer is asked again with an empty `sessionHash`: judge the account's current
   * scoped authority, not a session the member's request cannot supply. */
  authorize(
    tx: CommandReceiptTransaction,
    actor: WorkActor,
    target: { engagementId: string; guildId: string },
  ): Promise<boolean>;
  /** Transactional reservation of exactly the added obligation, distinct from every slot and amendment reservation. */
  reserveAdditionalFunding(
    tx: CommandReceiptTransaction,
    binding: {
      engagementId: string;
      amendmentId: string;
      increase: readonly RewardIncrease[];
      terms: z.infer<typeof TermsSnapshotSchema>;
    },
  ): Promise<string | null>;
  /** Recheck at consent time that the exact added reservation is still held. */
  fundingAvailable(
    tx: CommandReceiptTransaction,
    binding: {
      engagementId: string;
      amendmentId: string;
      fundingRef: string;
      increase: readonly RewardIncrease[];
    },
  ): Promise<boolean>;
  /** The affected member's explicit current consent to exactly this amendment digest. Null means no consent. */
  assessConsent(
    tx: CommandReceiptTransaction,
    context: {
      actor: WorkActor;
      participantId: string;
      engagementId: string;
      amendmentId: string;
      digest: string;
      terms: z.infer<typeof TermsSnapshotSchema>;
    },
  ): Promise<{ consentRef: string } | null>;
}
const text = z.string().trim().min(1).max(8000);
const amount = AmountSchema.refine((value) => {
  try {
    return fromJsonAmount(value) > 0n;
  } catch {
    return false;
  }
}, 'A positive bounded base-unit amount is required.');
/** The only amendable terms. Roster, reviewer, rights, policies and reward assets/beneficiaries need a new engagement. */
export const AmendmentChanges = z
  .strictObject({
    scope: text.optional(),
    acceptanceCriteria: z.array(text).min(1).max(50).optional(),
    rewards: z.array(z.strictObject({ amount })).min(1).max(10).optional(),
    deadlines: z
      .strictObject({
        preparation: UtcTimestamp.optional(),
        submission: UtcTimestamp.optional(),
        review: UtcTimestamp.optional(),
        operationalClosure: UtcTimestamp.optional(),
      })
      .refine((value) => Object.values(value).some((entry) => entry !== undefined))
      .optional(),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined));
export const ProposeAmendmentInput = z.strictObject({
  engagementId: z.uuid(),
  changes: AmendmentChanges,
  expiresAt: UtcTimestamp,
});
export const RespondAmendmentInput = z.strictObject({
  amendmentId: z.uuid(),
  decision: z.enum(['ACCEPT', 'DECLINE']),
});
export const WithdrawAmendmentInput = z.strictObject({ amendmentId: z.uuid() });
export const AmendmentSchema = z.strictObject({
  id: z.uuid(),
  engagementId: z.uuid(),
  sequence: z.number().int().min(1),
  state: z.enum(['PROPOSED', 'ACCEPTED', 'DECLINED', 'WITHDRAWN']),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  /** The complete terms that become effective only if the affected member consents. */
  terms: TermsSnapshotSchema,
  expiresAt: UtcTimestamp,
  requiresFunding: z.boolean(),
});
export const AmendmentResultSchema = z.strictObject({
  status: z.enum(['EXECUTED', 'REPLAYED']),
  amendment: AmendmentSchema,
});
export type Amendment = z.infer<typeof AmendmentSchema>;
export type AmendmentResult = z.infer<typeof AmendmentResultSchema>;
