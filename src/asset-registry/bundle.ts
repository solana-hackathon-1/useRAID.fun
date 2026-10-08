import type { AssetId } from '../contracts/assets';
import { InternalId } from '../contracts/ids';
import { checkedAdd, fromJsonAmount, toJsonAmount } from './amounts';
import { AssetRegistryError } from './errors';
import type { AssetIdInput, AssetRegistry } from './registry';

/**
 * Reward bundles (blueprint 16.4, 16.9): a reward is a vector of legs, one exact asset and amount
 * each. It is fully funded only when every promised asset has verified funds. Pure functions over
 * observations the host supplies; this module never reads a chain and never decides that an
 * observation is verified. An unverified observation is only ever `PENDING`.
 */
export type FundingLegState = 'REQUIRED' | 'PENDING' | 'VERIFIED' | 'SHORTFALL' | 'BLOCKED';
export interface RewardLeg {
  assetId: AssetIdInput;
  /** Base units as a canonical decimal string. */
  amount: string;
}
export interface FundingObservation {
  /**
   * Semantic funding operation ID, unique per credited deposit within the agreement the caller
   * scopes this call to. Repeated delivery of one operation is counted once.
   */
  operationId: string;
  assetId: AssetIdInput;
  amount: string;
  /** True only when the host verified the actual effect at the configured finality. */
  verified: boolean;
  /** Informational policy tag. Deliberately excluded from identity and aggregation. */
  registryVersion?: string;
}
export interface Credited {
  verified: bigint;
  pending: bigint;
}
export interface AssetFunding {
  readonly assetKey: string;
  readonly assetId: AssetId;
  readonly required: string;
  readonly verified: string;
  readonly pending: string;
  readonly state: FundingLegState;
}
export interface RewardFunding {
  readonly fullyFunded: boolean;
  readonly assets: readonly AssetFunding[];
}

interface Operation {
  key: string;
  assetId: AssetIdInput;
  amount: bigint;
  verified: boolean;
}

function dedupe(registry: AssetRegistry, observations: readonly FundingObservation[]) {
  if (!Array.isArray(observations)) throw new AssetRegistryError('INVALID_CONFIGURATION');
  const operations = new Map<string, Operation>();
  for (const observation of observations) {
    if (
      !observation ||
      !InternalId.safeParse(observation.operationId).success ||
      typeof observation.verified !== 'boolean'
    )
      throw new AssetRegistryError('INVALID_CONFIGURATION');
    const key = registry.keyOf(observation.assetId);
    const amount = fromJsonAmount(observation.amount);
    const known = operations.get(observation.operationId);
    if (!known) {
      operations.set(observation.operationId, {
        key,
        assetId: observation.assetId,
        amount,
        verified: observation.verified,
      });
    } else if (known.key !== key || known.amount !== amount) {
      throw new AssetRegistryError('CONFLICTING_OBSERVATION');
    } else known.verified = known.verified || observation.verified;
  }
  return operations;
}

/**
 * Credited base units per exact asset key. Operations are de-duplicated by `operationId`, so
 * redelivery or a policy-version tag can never add funds. Observations for assets the registry
 * does not know are ignored, never credited to a look-alike.
 */
export function creditedByAsset(
  registry: AssetRegistry,
  observations: readonly FundingObservation[],
): ReadonlyMap<string, Credited> {
  const credited = new Map<string, Credited>();
  for (const operation of dedupe(registry, observations).values()) {
    if (!registry.has(operation.assetId)) continue;
    const entry = credited.get(operation.key) ?? { verified: 0n, pending: 0n };
    if (operation.verified) entry.verified = checkedAdd(entry.verified, operation.amount);
    else entry.pending = checkedAdd(entry.pending, operation.amount);
    credited.set(operation.key, entry);
  }
  return credited;
}

export function evaluateRewardFunding(
  registry: AssetRegistry,
  legs: readonly RewardLeg[],
  observations: readonly FundingObservation[],
): RewardFunding {
  if (!Array.isArray(legs)) throw new AssetRegistryError('INVALID_CONFIGURATION');
  const required = new Map<string, { assetId: AssetIdInput; amount: bigint }>();
  for (const leg of legs) {
    const key = registry.keyOf(leg?.assetId);
    const amount = fromJsonAmount(leg.amount);
    if (amount === 0n) throw new AssetRegistryError('INVALID_AMOUNT');
    const known = required.get(key);
    required.set(key, {
      assetId: leg.assetId,
      amount: known ? checkedAdd(known.amount, amount) : amount,
    });
  }
  const credited = creditedByAsset(registry, observations);
  const assets: AssetFunding[] = [];
  for (const [key, leg] of required) {
    const have = credited.get(key) ?? { verified: 0n, pending: 0n };
    const blocked = !registry.has(leg.assetId) || !registry.evaluateSupport(leg.assetId).supported;
    const state: FundingLegState = blocked
      ? 'BLOCKED'
      : have.verified >= leg.amount
        ? 'VERIFIED'
        : have.pending > 0n
          ? 'PENDING'
          : have.verified > 0n
            ? 'SHORTFALL'
            : 'REQUIRED';
    assets.push(
      Object.freeze({
        assetKey: key,
        assetId: registry.has(leg.assetId) ? registry.resolve(leg.assetId).assetId : leg.assetId,
        required: toJsonAmount(leg.amount),
        verified: toJsonAmount(have.verified),
        pending: toJsonAmount(have.pending),
        state,
      }),
    );
  }
  return Object.freeze({
    fullyFunded: assets.length > 0 && assets.every((asset) => asset.state === 'VERIFIED'),
    assets: Object.freeze(assets),
  });
}
