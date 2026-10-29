import type { CommandReceiptTransaction as Tx } from '../command-receipts';
import { OfferSchema } from './admission-contracts';
import { fail } from './engagement-authority';
import type { AcceptanceHost } from './engagement-contracts';
import { z } from 'zod';
async function readLockedOffer(tx: Tx, id: string) {
  const rows = await tx.query<Record<string, unknown>>(
    'SELECT "id"::text,"applicationId"::text,"slotId"::text,"termsVersionId"::text,"participantId"::text,"expiresAt","state","acceptedEngagementId"::text,"offeredByAccountId" FROM "RaidOffer" WHERE "id"=$1::uuid FOR UPDATE',
    [id],
  );
  if (rows.length !== 1) fail('NOT_FOUND');
  const { offeredByAccountId, ...row } = rows[0];
  // The column is NOT NULL; an unusable value is a storage fault, never an issuer named "null".
  const issuer = z.string().min(1).safeParse(offeredByAccountId);
  if (!issuer.success) fail('STORAGE_CONTRACT');
  return {
    offer: OfferSchema.parse({
      ...row,
      expiresAt: row.expiresAt instanceof Date ? row.expiresAt.toISOString() : row.expiresAt,
    }),
    issuer: issuer.data,
  };
}
/**
 * The participant's offer most relevant to this slot, read without a lock: a live PENDING offer for these terms
 * first, otherwise the newest. A pre-screen only; acceptance rereads and locks the offer.
 */
export async function findParticipantOffer(
  tx: Tx,
  target: { participantId: string; slotId: string; termsVersionId: string },
  now: Date,
) {
  const rows = await tx.query<Record<string, unknown>>(
    `SELECT "id"::text,"applicationId"::text,"slotId"::text,"termsVersionId"::text,"participantId"::text,"expiresAt","state","acceptedEngagementId"::text FROM "RaidOffer" WHERE "participantId"=$1::uuid AND "slotId"=$2::uuid ORDER BY ("state"='PENDING' AND "termsVersionId"=$3::uuid AND "expiresAt">$4::timestamptz) DESC,"createdAt" DESC LIMIT 1`,
    [target.participantId, target.slotId, target.termsVersionId, now.toISOString()],
  );
  if (!rows.length) return undefined;
  const row = rows[0];
  return OfferSchema.parse({
    ...row,
    expiresAt: row.expiresAt instanceof Date ? row.expiresAt.toISOString() : row.expiresAt,
  });
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
  // Callers also check up front; keep this guard so the non-null assertion below never rests on a caller.
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
