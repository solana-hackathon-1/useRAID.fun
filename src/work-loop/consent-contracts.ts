import { z } from 'zod';
import { UtcTimestamp } from '../contracts/ids';

/**
 * A person's explicit consent to the exact terms of one slot (blueprint §10.2 step 5, §23.4). It names the terms
 * digest the person was shown, so a changed version cannot be accepted on old consent. It grants nothing on its own.
 */
export interface ConsentHost {
  allowNewWrites: boolean;
}
export const RecordConsentInput = z.strictObject({
  slotId: z.uuid(),
  termsVersionId: z.uuid(),
  termsDigest: z.string().regex(/^[0-9a-f]{64}$/),
});
export const ConsentSchema = z.strictObject({
  id: z.uuid(),
  participantId: z.uuid(),
  slotId: z.uuid(),
  termsVersionId: z.uuid(),
  termsDigest: z.string().regex(/^[0-9a-f]{64}$/),
  consentedAt: UtcTimestamp,
});
export const ConsentResultSchema = z.strictObject({
  status: z.enum(['EXECUTED', 'REPLAYED']),
  consent: ConsentSchema,
});
export type ConsentResult = z.infer<typeof ConsentResultSchema>;
/** Withdrawing an unused consent (DEC-2026-11-14-07). It only reduces commitment, so no feature flag or write switch gates it. */
export const WithdrawConsentInput = z.strictObject({ consentId: z.uuid() });
export const ConsentWithdrawalSchema = z.strictObject({
  id: z.uuid(),
  consentId: z.uuid(),
  withdrawnAt: UtcTimestamp,
});
export const ConsentWithdrawalResultSchema = z.strictObject({
  status: z.enum(['EXECUTED', 'REPLAYED']),
  withdrawal: ConsentWithdrawalSchema,
});
export type ConsentWithdrawalResult = z.infer<typeof ConsentWithdrawalResultSchema>;
