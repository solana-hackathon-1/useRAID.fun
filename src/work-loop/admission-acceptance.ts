import type { CommandReceiptTransaction as Tx } from '../command-receipts';
import { OfferSchema } from './admission-contracts';
import { fail } from './engagement-authority';
import type { AcceptanceHost } from './engagement-contracts';
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
  if (offer.state !== 'PENDING') fail('OFFER_UNAVAILABLE');
  if (Date.parse(offer.expiresAt) <= now.getTime()) fail('OFFER_EXPIRED');
}
/** An offer is usable only while its issuing Founder still holds the authority it was made under. */
export async function assertOfferIssuerAuthorized(
  tx: Tx,
  offerId: string,
  target: { slotId: string; guildId: string },
  host: Pick<AcceptanceHost, 'authorizeOfferIssuer'>,
) {
  // Fail closed: a host that cannot answer this question cannot accept applications.
  if (typeof host.authorizeOfferIssuer !== 'function') fail('STORAGE_CONTRACT');
  const [row] = await tx.query<{ issuer: string }>(
    'SELECT "offeredByAccountId" AS issuer FROM "RaidOffer" WHERE "id"=$1::uuid',
    [offerId],
  );
  if (!row) fail('NOT_FOUND');
  // The issuer has no session in the applicant's request: the host judges the account's current scoped authority.
  if (
    (await host.authorizeOfferIssuer(tx, { accountId: row.issuer }, { offerId, ...target })) !==
    true
  )
    fail('OFFER_UNAVAILABLE');
}
