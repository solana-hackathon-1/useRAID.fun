import { assetKey } from '../contracts/assets';
import {
  GuildHolderContextSchema,
  GuildHolderObservationSchema,
  GuildHolderContractError,
  type GuildHolderEligibility,
  type GuildHolderReason,
} from './holder-observation-contracts';
export * from './holder-observation-contracts';
/** Private informational calculation; current recognized authority and real chain observations are host-owned. */
export function evaluateGuildHolderEligibility(
  contextValue: unknown,
  observationValue: unknown,
): GuildHolderEligibility {
  const parsed = GuildHolderContextSchema.safeParse(contextValue);
  if (!parsed.success) throw new GuildHolderContractError('INVALID_HOST_CONTRACT');
  const c = parsed.data;
  if (!c.actorAccountId || !c.actorSessionAuthorized)
    throw new GuildHolderContractError('AUTHENTICATION_REQUIRED');
  if (c.actorRestricted) throw new GuildHolderContractError('ACCOUNT_RESTRICTED');
  if (c.actorAccountId !== c.accountId) throw new GuildHolderContractError('FORBIDDEN');
  const parsedObservation =
    observationValue === null ? null : GuildHolderObservationSchema.safeParse(observationValue);
  if (parsedObservation && !parsedObservation.success)
    throw new GuildHolderContractError('INVALID_HOST_CONTRACT');
  const o = parsedObservation?.success ? parsedObservation.data : null;
  const result = (
    reason: GuildHolderReason,
    balance: bigint | null = null,
  ): GuildHolderEligibility => {
    const known = balance !== null;
    const eligible = known ? balance >= BigInt(c.policy.minimumBalanceBaseUnits) : null;
    const metadata =
      o?.status === 'VERIFIED' &&
      (known ||
        reason === 'OBSERVATION_STALE' ||
        reason === 'OBSERVATION_NOT_YET_VALID' ||
        reason === 'FINALITY_PENDING')
        ? o
        : null;
    return Object.freeze({
      version: 'v1',
      guildId: c.guild.id,
      targetAssetId: c.guild.primaryToken,
      relationshipReference: c.relationship.reference,
      policyReference: c.policy.reference,
      computedAt: new Date(c.now).toISOString(),
      state: known
        ? eligible
          ? 'ELIGIBLE'
          : 'NOT_ELIGIBLE'
        : reason === 'OBSERVATION_STALE'
          ? 'STALE'
          : 'UNKNOWN',
      holderEligible: eligible,
      reason,
      balanceBaseUnits: balance?.toString() ?? null,
      observedAt: metadata ? new Date(metadata.observedAt).toISOString() : null,
      observedSlot: metadata?.observedSlot ?? null,
      finality: metadata?.finality ?? null,
      provider: o?.provider ?? null,
      informational: true,
      isAuthorizationToken: false,
      persisted: false,
      createsPermissionGrant: false,
      verifiesFounderControl: false,
      enrollsPublicAssociation: false,
      subscribesNotifications: false,
      consumesCapacity: false,
      affectsWorkHistory: false,
      affectsClaims: false,
    });
  };
  if (c.relationship.status !== 'VERIFIED' || !c.guild.primaryToken)
    return result('RELATIONSHIP_UNAVAILABLE');
  if (c.policy.status !== 'APPROVED') return result('POLICY_UNAVAILABLE');
  if (c.policy.ownershipScope !== 'CURRENT_VERIFIED_LINKED_WALLETS')
    return result('OWNERSHIP_SCOPE_UNSUPPORTED');
  if (!c.wallets.length) return result('OWNERSHIP_UNAVAILABLE');
  if (!o || o.status === 'UNAVAILABLE') return result('PROVIDER_UNAVAILABLE');
  if (o.status === 'CONFLICT') return result('SOURCE_CONFLICT');
  const sameReference = (a: typeof c.relationship.reference, b: typeof a) =>
    a.recordId === b.recordId && a.revision === b.revision;
  if (!sameReference(c.relationship.reference, o.relationshipReference))
    return result('RELATIONSHIP_CHANGED');
  if (!sameReference(c.policy.reference, o.policyReference)) return result('POLICY_CHANGED');
  const asset = assetKey(c.guild.primaryToken);
  if (assetKey(o.assetId) !== asset) return result('ASSET_MISMATCH');
  if (
    new Set(o.queriedWallets).size !== o.queriedWallets.length ||
    o.queriedWallets.length !== c.wallets.length ||
    o.queriedWallets.some((wallet) => !c.wallets.includes(wallet))
  )
    return result('OWNERSHIP_SCOPE_MISMATCH');
  if (!o.complete) return result('INCOMPLETE_OBSERVATION');
  const age = Date.parse(c.now) - Date.parse(o.observedAt);
  if (age < 0) return result('OBSERVATION_NOT_YET_VALID');
  if (age >= c.policy.maxObservationAgeMs) return result('OBSERVATION_STALE');
  const finality = { PROCESSED: 0, CONFIRMED: 1, FINALIZED: 2 };
  if (finality[o.finality] < finality[c.policy.minimumFinality]) return result('FINALITY_PENDING');
  const accounts = new Map<string, { owner: string; balance: string }>();
  let balance = 0n;
  for (const row of o.accounts) {
    if (assetKey(row.assetId) !== asset) return result('ASSET_MISMATCH');
    if (!c.wallets.includes(row.owner)) return result('OWNERSHIP_SCOPE_MISMATCH');
    const previous = accounts.get(row.address);
    if (previous) {
      if (previous.owner !== row.owner || previous.balance !== row.balanceBaseUnits)
        return result('SOURCE_CONFLICT');
      continue;
    }
    accounts.set(row.address, { owner: row.owner, balance: row.balanceBaseUnits });
    balance += BigInt(row.balanceBaseUnits);
  }
  return result('VERIFIED_BALANCE', balance);
}
