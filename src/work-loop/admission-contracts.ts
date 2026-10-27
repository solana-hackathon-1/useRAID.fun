import { z } from 'zod';
import { InternalId, UtcTimestamp } from '../contracts/ids';
import type { WorkHost } from './contracts';
export interface AdmissionHost {
  allowNewWrites: boolean;
  /** Explicit versioned host policy; blueprint DEFAULT fixture is five. */
  applicationLimit: number;
  /** Current scoped Founder authority held through transaction commit. */
  authorize: WorkHost['authorize'];
}
/** Applying is nonbinding: the evidence ids are opaque references the applicant already owns. */
export const SubmitApplicationInput = z.strictObject({
  slotId: z.uuid(),
  termsVersionId: z.uuid(),
  evidenceRefs: z.array(InternalId).max(10),
});
export const ApplicationSchema = z.strictObject({
  id: z.uuid(),
  slotId: z.uuid(),
  termsVersionId: z.uuid(),
  participantId: z.uuid(),
  evidenceRefs: z.array(InternalId).max(10),
  state: z.enum(['SUBMITTED', 'WITHDRAWN', 'CLOSED']),
});
export const OfferSchema = z.strictObject({
  id: z.uuid(),
  applicationId: z.uuid(),
  slotId: z.uuid(),
  termsVersionId: z.uuid(),
  participantId: z.uuid(),
  expiresAt: UtcTimestamp,
  state: z.enum(['PENDING', 'REVOKED', 'ACCEPTED']),
  acceptedEngagementId: z.uuid().nullable(),
});
export const ApplicationResultSchema = z.strictObject({
  status: z.enum(['EXECUTED', 'REPLAYED']),
  application: ApplicationSchema,
});
export const OfferResultSchema = z.strictObject({
  status: z.enum(['EXECUTED', 'REPLAYED']),
  offer: OfferSchema,
});
