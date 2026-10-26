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
  /** Transactional host reservation. Must bind this exact slot/version/reward, distinct from any other slot. */
  reserveSimulatedFunding(
    tx: CommandReceiptTransaction,
    binding: { slotId: string; termsVersionId: string; terms: RaidTerms },
  ): Promise<string | null>;
}
export class WorkError extends Error {
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'APPLICATION_LIMIT'
      | 'APPLICATION_EXISTS'
      | 'APPLICATION_CLOSED'
      | 'OFFER_UNAVAILABLE'
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
      | 'STORAGE_CONTRACT',
    readonly currentEngagementId?: string,
  ) {
    super(code);
    this.name = 'WorkError';
  }
}
