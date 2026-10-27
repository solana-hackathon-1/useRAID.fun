import type { CommandReceiptTransaction as Tx } from '../command-receipts';
import { OfferSchema } from './admission-contracts';
import { fail } from './engagement-authority';
import type { AcceptanceHost } from './engagement-contracts';
import type { z } from 'zod';
async function readLockedOffer(tx: Tx, id: string) {
  const rows = await tx.query<Record<string, unknown>>(
    'SELECT "id"::text,"applicationId"::text,"slotId"::text,"termsVersionId"::text,"participantId"::text,"expiresAt","state","acceptedEngagementId"::text,"offeredByAccountId" FROM "RaidOffer" WHERE "id"=$1::uuid FOR UPDATE',
    [id],
  );
  if (rows.length !== 1) fail('NOT_FOUND');
  const { offeredByAccountId, ...row } = rows[0];
  return {
    offer: OfferSchema.parse({
      ...row,
      expiresAt: row.expiresAt instanceof Date ? row.expiresAt.toISOString() : row.expiresAt,
    }),
    issuer: String(offeredByAccountId),
  };
}
export async function lockOffer(tx: Tx, id: string) {
  return (await readLockedOffer(tx, id)).offer;
}
/** The locked offer plus the account that issued it, read in the same statement. */
export const lockOfferForAcceptance = readLockedOffer;
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
  offer: { id: string; issuer: string },
  target: { slotId: string; guildId: string },
  host: Pick<AcceptanceHost, 'authorizeOfferIssuer'>,
) {
  requireOfferIssuerCheck(host);
  // The issuer has no session in the applicant's request: the host judges the account's current scoped authority.
  if (
    (await host.authorizeOfferIssuer!(
      tx,
      { accountId: offer.issuer },
      { offerId: offer.id, ...target },
    )) !== true
  )
    fail('OFFER_UNAVAILABLE');
}
/** Fail closed before any host callback or side effect: a host that cannot answer this cannot accept applications. */
export function requireOfferIssuerCheck(host: Pick<AcceptanceHost, 'authorizeOfferIssuer'>) {
  if (typeof host.authorizeOfferIssuer !== 'function') fail('STORAGE_CONTRACT');
}
