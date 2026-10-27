import type { CommandReceiptTransaction } from '../command-receipts';
import type { RaidTerms } from './terms';
export interface WorkActor {
  accountId: string;
  sessionHash: string;
}
export interface WorkCommand {
  actor: WorkActor;
  input: unknown;
  idempotencyKey: string;
  requestId: string;
}
export interface WorkHost {
  /** Trusted current session + scoped Guild authority, held/rechecked through commit. Never caller flags. */
  authorize(
    tx: CommandReceiptTransaction,
    actor: WorkActor,
    guildId: string,
    action: 'MANAGE_LISTING',
  ): Promise<boolean>;
  /** Default off. Original receipts/current authorized reads remain available when off. */
  allowNewWrites: boolean;
  /** Transactional host coverage. Bind this exact slot/version/reward and return its distinct reference.
   * Canonical publication/replacement records WorkSimulatedReservation; hosts must not insert that row. */
  reserveSimulatedFunding(
    tx: CommandReceiptTransaction,
    binding: { slotId: string; termsVersionId: string; terms: RaidTerms },
  ): Promise<string | null>;
}
export class WorkError extends Error {
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'ENGAGEMENT_STATE'
      | 'DEADLINE_NOT_REACHED'
      | 'REVISION_LIMIT'
      | 'REVIEW_EXISTS'
      | 'APPLICATION_LIMIT'
      | 'APPLICATION_EXISTS'
      | 'APPLICATION_CLOSED'
      | 'OFFER_UNAVAILABLE'
      | 'OFFER_EXPIRED'
      | 'OFFER_EXISTS'
      | 'UNAUTHENTICATED'
      | 'ACCOUNT_RESTRICTED'
      | 'ELIGIBILITY_REJECTED'
      | 'CAPACITY_CONFLICT'
      | 'SLOT_FILLED'
      | 'TERMS_VERSION_CHANGED'
      | 'ADMISSION_REQUIRED'
      | 'DEADLINE_PASSED'
      | 'FORBIDDEN'
      | 'WRITES_DISABLED'
      | 'NOT_FOUND'
      | 'REVISION_CONFLICT'
      | 'TERMS_FROZEN'
      | 'PUBLICATION_BLOCKED'
      | 'FUNDING_REQUIRED'
      | 'AMENDMENT_EXISTS'
      | 'AMENDMENT_UNAVAILABLE'
      | 'CONSENT_REQUIRED'
      | 'REPLACEMENT_EXISTS'
      | 'STORAGE_CONTRACT',
    readonly currentEngagementId?: string,
  ) {
    super(code);
    this.name = 'WorkError';
  }
}
