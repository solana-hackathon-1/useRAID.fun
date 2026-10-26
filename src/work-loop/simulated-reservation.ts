import { assetKey } from '../contracts/assets';
import { canonicalRequestDigest, type CommandReceiptTransaction as Tx } from '../command-receipts';
import type { RewardAsset } from './creation-form';
import type { WorkHost } from './contracts';

/**
 * `WorkHost.reserveSimulatedFunding` backed by a host-declared catalog of synthetic coverage. A reward is
 * reserved only when EVERY leg's asset is covered; one uncovered leg returns null so the whole reward is
 * unfunded and nothing becomes eligible for commitment. The record is simulated coverage, not a balance.
 */
export function createSimulatedReservations(
  catalog: readonly RewardAsset[],
): WorkHost['reserveSimulatedFunding'] {
  return async (tx: Tx, binding) => {
    const legs = binding.terms.rewards;
    const covered = legs.every((leg) =>
      catalog.some(
        (asset) => asset.funded && assetKey(asset.policy.assetId) === assetKey(leg.policy.assetId),
      ),
    );
    if (!legs.length || !covered) return null;
    await tx.query(
      'INSERT INTO "WorkSimulatedReservation" ("slotId","termsVersionId","vectorDigest","legs") VALUES ($1::uuid,$2::uuid,$3,$4::jsonb) RETURNING "slotId"',
      [binding.slotId, binding.termsVersionId, canonicalRequestDigest(legs), JSON.stringify(legs)],
    );
    return 'sim-reservation:' + binding.slotId;
  };
}
