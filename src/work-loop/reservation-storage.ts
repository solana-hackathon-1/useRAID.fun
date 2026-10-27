import { canonicalRequestDigest, type CommandReceiptTransaction as Tx } from '../command-receipts';
import type { RaidTerms } from './terms';

/** Canonical commands record the replaceable host's exact returned reference; no live balance is implied. */
export async function recordSimulatedReservation(
  tx: Tx,
  binding: { slotId: string; termsVersionId: string; terms: RaidTerms },
  fundingRef: string,
) {
  await tx.query(
    'INSERT INTO "WorkSimulatedReservation" ("slotId","termsVersionId","fundingRef","vectorDigest","legs") VALUES ($1::uuid,$2::uuid,$3,$4,$5::jsonb) RETURNING "slotId"',
    [
      binding.slotId,
      binding.termsVersionId,
      fundingRef,
      canonicalRequestDigest(binding.terms.rewards),
      JSON.stringify(binding.terms.rewards),
    ],
  );
}
