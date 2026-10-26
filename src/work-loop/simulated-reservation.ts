import { assetKey } from '../contracts/assets';
import { canonicalRequestDigest, type CommandReceiptTransaction as Tx } from '../command-receipts';
import { samePolicy, type RewardAsset } from './creation-form';
import type { WorkHost } from './contracts';

/**
 * `WorkHost.reserveSimulatedFunding` backed by a host-declared catalog of synthetic coverage. A reward is
 * reserved only when EVERY leg matches a covered catalog policy exactly (one leg per asset); one uncovered leg returns null so the whole reward is
 * unfunded and nothing becomes eligible for commitment. The record is simulated coverage, not a balance.
 */
export function createSimulatedReservations(
  catalog: readonly RewardAsset[],
): WorkHost['reserveSimulatedFunding'] {
  return async (tx: Tx, binding) => {
    const legs = binding.terms.rewards;
    const keys = legs.map((leg) => assetKey(leg.policy.assetId));
    // One leg per asset, and each leg must carry the catalog's exact policy: identity alone is not coverage.
    const covered =
      new Set(keys).size === keys.length &&
      legs.every((leg) =>
        catalog.some((asset) => asset.funded && samePolicy(asset.policy, leg.policy)),
      );
    if (!legs.length || !covered) return null;
    await tx.query(
      'INSERT INTO "WorkSimulatedReservation" ("slotId","termsVersionId","vectorDigest","legs") VALUES ($1::uuid,$2::uuid,$3,$4::jsonb) RETURNING "slotId"',
      [binding.slotId, binding.termsVersionId, canonicalRequestDigest(legs), JSON.stringify(legs)],
    );
    return 'sim-reservation:' + binding.slotId;
  };
}
