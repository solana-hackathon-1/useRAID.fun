import { z } from 'zod';
import { EngagementSchema } from '../contracts/entities';
import type { CommandReceiptTransaction } from '../command-receipts';
import type { IdentityLockCapability } from '../identity-locks';
import type { WorkActor } from './contracts';
import type { RaidTerms } from './terms';
export interface AcceptanceApproval {
  consentRef: string;
  beneficiaryRef: string;
  eligibilityPolicyVersion: string;
  /** Managed operators/AI/Parties are not enabled by the human solo host. */
  operatorId: null;
}
export interface AcceptanceHost {
  allowNewWrites: boolean;
  /** Optional same-transaction prelocked composition; validated, never caller-supplied HTTP data. */
  identityLocks?: IdentityLockCapability;
  /** Current exact-term eligibility AND explicit participant consent, transaction-local, no network calls. */
  assess(
    tx: CommandReceiptTransaction,
    context: {
      actor: WorkActor;
      participantId: string;
      slotId: string;
      termsVersionId: string;
      terms: RaidTerms;
    },
  ): Promise<AcceptanceApproval | null>;
  /**
   * Lock order: `assess` is given the assessment advisory lock (class 12022) before it runs and acceptance keeps it to
   * commit, while `authorizeOfferIssuer` and `fundingAvailable` run with it held. Those callbacks must therefore be
   * read-only checks that take no identity or `User` row locks: a decision path locks the evaluator's `User` row and
   * then 12022, so a host callback locking a `User` row here could deadlock with a revoke. They also bound how long a
   * slow decision can hold up acceptances of the same slot and listing; no `lock_timeout` is applied.
   */
  /** Required whenever a terms version uses APPLICATION admission; acceptance with an offer fails closed without it.
   * Current scoped MANAGE_LISTING authority of the offer's issuing Founder (suspension or loss makes the offer
   * unusable). The issuer has no session in the applicant's request: judge the account, never a session.
   * Asked once, last before the engagement insert and never re-asked: the answer must hold until commit, so read
   * the authority inside `tx` with a lock a revocation must wait for (e.g. `FOR SHARE`), or from state that cannot
   * change mid-transaction. */
  authorizeOfferIssuer?(
    tx: CommandReceiptTransaction,
    issuer: { accountId: string },
    target: { offerId: string; slotId: string; guildId: string },
  ): Promise<boolean>;
  /** Recheck the exact reserved reward, not just an aggregate balance or the existence of a string. */
  fundingAvailable(
    tx: CommandReceiptTransaction,
    binding: {
      slotId: string;
      termsVersionId: string;
      fundingRef: string;
      terms: RaidTerms;
    },
  ): Promise<boolean>;
}
/** Accept a slot at its exact terms version, optionally through the Founder's offer. */
export const CommitEngagementInput = z.strictObject({
  slotId: z.uuid(),
  termsVersionId: z.uuid(),
  offerId: z.uuid().optional(),
});
export const CommittedEngagementSchema = z.strictObject({
  status: z.enum(['EXECUTED', 'REPLAYED']),
  fundingMode: z.literal('SIMULATED'),
  generation: z.number().int().min(1),
  /** The Founder's offer this engagement was accepted through, or null for a direct acceptance. */
  offerId: z.uuid().nullable(),
  engagement: EngagementSchema,
});
export type CommittedEngagement = z.infer<typeof CommittedEngagementSchema>;
