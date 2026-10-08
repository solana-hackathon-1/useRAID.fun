import { z } from 'zod';
// Vocabulary only: not an executable authorization/transition policy.
export const STATES = {
  listing: ['DRAFT', 'FUNDING_PENDING', 'OPEN', 'PAUSED', 'CLOSED', 'CANCELLED', 'ARCHIVED'],
  slot: ['AVAILABLE', 'FILLED', 'CLOSED'],
  application: [
    'SUBMITTED',
    'SHORTLISTED',
    'REJECTED',
    'WITHDRAWN',
    'CONVERTED_TO_OFFER',
    'CLOSED',
  ],
  offer: ['OFFERED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'REVOKED'],
  engagement: [
    'ACCESS_PENDING',
    'IN_PROGRESS',
    'SUBMITTED',
    'UNDER_REVIEW',
    'REVISION_REQUESTED',
    'ACCEPTED',
    'WITHDRAWN',
    'CANCELLED',
    'TERMINATED',
  ],
  challenge: [
    'DRAFT',
    'APPLICATIONS_OPEN',
    'BUILDING',
    'JUDGING',
    'DECIDED',
    'CLOSED',
    'CANCELLED',
  ],
  agreement: ['OPEN', 'COMMITTED', 'ALLOCATING', 'SETTLING', 'CLOSED'],
  funding: ['REQUIRED', 'PENDING', 'VERIFIED', 'SHORTFALL', 'BLOCKED'],
  claim: ['ALLOCATED', 'READY', 'SUBMITTED', 'FINALIZED', 'BLOCKED'],
  dispute: ['NONE', 'OPEN', 'EVIDENCE', 'DECIDED', 'APPEALED', 'CLOSED'],
  transaction: [
    'CREATED',
    'AWAITING_SIGNATURE',
    'SIGNED',
    'SUBMITTED',
    'CONFIRMED',
    'FINALIZED',
    'EXPIRED',
    'FAILED',
    'UNKNOWN',
  ],
  access: [
    'REQUESTED',
    'APPROVED',
    'PROVISIONING',
    'ACTIVE',
    'FAILED',
    'REVOCATION_PENDING',
    'REVOKED',
    'EXPIRED',
  ],
  run: [
    'PLANNED',
    'BUDGET_RESERVED',
    'QUEUED',
    'RUNNING',
    'SUBMITTED',
    'PAUSED',
    'CANCEL_REQUESTED',
    'CANCELLED',
    'FAILED',
  ],
} as const;
export const StateSchema = {
  listing: z.enum(STATES.listing),
  slot: z.enum(STATES.slot),
  application: z.enum(STATES.application),
  offer: z.enum(STATES.offer),
  engagement: z.enum(STATES.engagement),
  challenge: z.enum(STATES.challenge),
  agreement: z.enum(STATES.agreement),
  funding: z.enum(STATES.funding),
  claim: z.enum(STATES.claim),
  dispute: z.enum(STATES.dispute),
  transaction: z.enum(STATES.transaction),
  access: z.enum(STATES.access),
  run: z.enum(STATES.run),
};
export type EngagementState = z.infer<typeof StateSchema.engagement>;
export function consumesCapacity(state: EngagementState): boolean {
  StateSchema.engagement.parse(state);
  return !(['ACCEPTED', 'WITHDRAWN', 'CANCELLED', 'TERMINATED'] as readonly string[]).includes(
    state,
  );
}
