import { assetKey } from '../contracts/assets';
import { RewardAssetSchema } from './creation-contracts';
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
  const parsed = RewardAssetSchema.array().max(20).safeParse(catalog);
  const valid =
    parsed.success &&
    new Set(parsed.data.map((asset) => assetKey(asset.policy.assetId))).size === parsed.data.length;
  const checked = valid && parsed.success ? parsed.data : [];
  return async (_tx, binding) => {
    const legs = binding.terms.rewards;
    const keys = legs.map((leg) => assetKey(leg.policy.assetId));
    // One leg per asset, and each leg must carry the catalog's exact policy: identity alone is not coverage.
    const covered =
      new Set(keys).size === keys.length &&
      legs.every((leg) =>
        checked.some((asset) => asset.funded && samePolicy(asset.policy, leg.policy)),
      );
    if (!legs.length || !covered) return null;
    return 'sim-reservation:' + binding.slotId;
  };
}
