import type { CommandReceiptTransaction as Tx } from '../command-receipts';
import { OfferSchema } from './admission-contracts';
import { fail } from './engagement-authority';
import type { z } from 'zod';
export async function lockOffer(tx: Tx, id: string) {
  const rows = await tx.query<Record<string, unknown>>(
    'SELECT "id"::text,"applicationId"::text,"slotId"::text,"termsVersionId"::text,"participantId"::text,"expiresAt","state","acceptedEngagementId"::text FROM "RaidOffer" WHERE "id"=$1::uuid FOR UPDATE',
    [id],
  );
  if (rows.length !== 1) fail('NOT_FOUND');
  const row = rows[0];
  return OfferSchema.parse({
    ...row,
    expiresAt: row.expiresAt instanceof Date ? row.expiresAt.toISOString() : row.expiresAt,
  });
}
export function assertOffer(
  offer: z.infer<typeof OfferSchema>,
  input: { slotId: string; termsVersionId: string },
  participantId: string,
  now: Date,
) {
  if (offer.participantId !== participantId) fail('FORBIDDEN');
  if (offer.slotId !== input.slotId || offer.termsVersionId !== input.termsVersionId)
    fail('TERMS_VERSION_CHANGED');
  if (offer.state !== 'PENDING' || Date.parse(offer.expiresAt) <= now.getTime())
    fail('OFFER_UNAVAILABLE');
}
