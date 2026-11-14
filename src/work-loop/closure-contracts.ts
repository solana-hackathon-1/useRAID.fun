import { z } from 'zod';
import { UtcTimestamp } from '../contracts/ids';
import { AmountSchema, AssetPolicySnapshotSchema } from '../contracts/assets';
import type { CommandReceiptTransaction } from '../command-receipts';
import type { WorkActor } from './contracts';
/**
 * The only service principal (DEC-2026-11-14-08, #352): a named, credential-less actor for scheduled timeout closures.
 * It is not a `User` row, so it cannot hold a Session, wallet or X link, Guild grant, participant capacity or
 * operator-allowlist membership, and the database refuses an account of this name. It is not a secret: only the worker
 * composition calls `closeOverdueEngagementAsPrincipal`, which no HTTP route does.
 */
export const WORK_CLOSURE_PRINCIPAL = 'work-closure' as const;
export interface ServicePrincipal {
  principal: typeof WORK_CLOSURE_PRINCIPAL;
}
/** A closer: a human with a current Session, or the service principal (timeout closure only). */
export type ClosureCaller = WorkActor | ServicePrincipal;
export interface ServicePrincipalCommand extends ServicePrincipal {
  input: unknown;
  idempotencyKey: string;
  requestId: string;
}
export interface ClosureHost {
  allowNewWrites: boolean;
  /**
   * Current operations authority for this engagement's Guild, rechecked by the host in this transaction. A human is
   * authorized by the host's operations authority; the service principal (recognized by its `principal` field, never
   * an account id) is authorized by the host for timeout closure only.
   */
  authorize(
    tx: CommandReceiptTransaction,
    actor: ClosureCaller,
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
