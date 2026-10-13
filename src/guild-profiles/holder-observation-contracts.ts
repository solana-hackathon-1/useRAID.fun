import { z } from 'zod';
import { AmountSchema, SolanaAddress, TokenAssetIdSchema } from '../contracts/assets';
import { AccountId, InternalId, Revision, UtcTimestamp } from '../contracts/ids';
import { GuildSchema } from '../contracts/entities';
const Timestamp = UtcTimestamp.refine((value) => {
  const fraction = value.match(/\.(\d+)Z$/)?.[1];
  return !fraction || fraction.length <= 3;
});
const Reference = z.strictObject({ recordId: InternalId, revision: Revision }).readonly();
const RawUnits = AmountSchema.max(78);
const Provider = z.strictObject({ id: InternalId, adapterVersion: InternalId }).readonly();
const Wallets = z.array(SolanaAddress).max(1000);
/** Current authenticated self, actual recognized asset and approved policy; never HTTP caller input. */
export const GuildHolderContextSchema = z.strictObject({
  version: z.literal('v1'),
  now: Timestamp,
  guild: GuildSchema,
  relationship: z.strictObject({
    reference: Reference,
    status: z.enum(['VERIFIED', 'PENDING', 'REVOKED', 'CONFLICT']),
  }),
  actorAccountId: AccountId.nullable(),
  actorSessionAuthorized: z.boolean(),
  actorRestricted: z.boolean(),
  accountId: AccountId,
  wallets: Wallets.refine((values) => new Set(values).size === values.length),
  policy: z.strictObject({
    reference: Reference,
    status: z.enum(['APPROVED', 'UNAPPROVED', 'REVOKED']),
    ownershipScope: z.enum(['CURRENT_VERIFIED_LINKED_WALLETS', 'UNSUPPORTED']),
    minimumBalanceBaseUnits: RawUnits.refine((value) => BigInt(value) > 0n),
    minimumFinality: z.enum(['CONFIRMED', 'FINALIZED']),
    maxObservationAgeMs: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  }),
});
export const GuildHolderObservationSchema = z.discriminatedUnion('status', [
  z.strictObject({
    version: z.literal('v1'),
    status: z.literal('VERIFIED'),
    relationshipReference: Reference,
    policyReference: Reference,
    assetId: TokenAssetIdSchema,
    queriedWallets: Wallets,
    complete: z.boolean(),
    observedAt: Timestamp,
    observedSlot: RawUnits,
    finality: z.enum(['PROCESSED', 'CONFIRMED', 'FINALIZED']),
    provider: Provider,
    accounts: z
      .array(
        z.strictObject({
          address: SolanaAddress,
          owner: SolanaAddress,
          assetId: TokenAssetIdSchema,
          balanceBaseUnits: RawUnits,
        }),
      )
      .max(10000),
  }),
  z.strictObject({
    version: z.literal('v1'),
    status: z.literal('UNAVAILABLE'),
    provider: Provider,
  }),
  z.strictObject({ version: z.literal('v1'), status: z.literal('CONFLICT'), provider: Provider }),
]);
export type GuildHolderContext = z.infer<typeof GuildHolderContextSchema>;
export type GuildHolderObservation = z.infer<typeof GuildHolderObservationSchema>;
export type GuildHolderObservationRequest = Readonly<{
  version: 'v1';
  guildId: string;
  relationshipReference: Readonly<{ recordId: string; revision: number }>;
  policyReference: Readonly<{ recordId: string; revision: number }>;
  assetId: z.infer<typeof TokenAssetIdSchema>;
  wallets: readonly string[];
}>;
/** Explicit complete-scope read port. Real host owns timeout, trusted network/config and post-read rechecks. */
export interface GuildHolderObservationAdapter {
  readonly version: 'v1';
  observe(request: GuildHolderObservationRequest): Promise<GuildHolderObservation>;
}
export type GuildHolderReason =
  | 'VERIFIED_BALANCE'
  | 'RELATIONSHIP_UNAVAILABLE'
  | 'POLICY_UNAVAILABLE'
  | 'OWNERSHIP_SCOPE_UNSUPPORTED'
  | 'OWNERSHIP_UNAVAILABLE'
  | 'PROVIDER_UNAVAILABLE'
  | 'SOURCE_CONFLICT'
  | 'RELATIONSHIP_CHANGED'
  | 'POLICY_CHANGED'
  | 'ASSET_MISMATCH'
  | 'OWNERSHIP_SCOPE_MISMATCH'
  | 'INCOMPLETE_OBSERVATION'
  | 'OBSERVATION_NOT_YET_VALID'
  | 'OBSERVATION_STALE'
  | 'FINALITY_PENDING';
export type GuildHolderEligibility = Readonly<{
  version: 'v1';
  guildId: string;
  targetAssetId: z.infer<typeof TokenAssetIdSchema> | null;
  relationshipReference: Readonly<{ recordId: string; revision: number }>;
  policyReference: Readonly<{ recordId: string; revision: number }>;
  computedAt: string;
  state: 'ELIGIBLE' | 'NOT_ELIGIBLE' | 'UNKNOWN' | 'STALE';
  holderEligible: boolean | null;
  reason: GuildHolderReason;
  balanceBaseUnits: string | null;
  observedAt: string | null;
  observedSlot: string | null;
  finality: 'PROCESSED' | 'CONFIRMED' | 'FINALIZED' | null;
  provider: Readonly<{ id: string; adapterVersion: string }> | null;
  informational: true;
  isAuthorizationToken: false;
  persisted: false;
  createsPermissionGrant: false;
  verifiesFounderControl: false;
  enrollsPublicAssociation: false;
  subscribesNotifications: false;
  consumesCapacity: false;
  affectsWorkHistory: false;
  affectsClaims: false;
}>;
export class GuildHolderContractError extends Error {
  constructor(
    readonly code:
      'INVALID_HOST_CONTRACT' | 'AUTHENTICATION_REQUIRED' | 'ACCOUNT_RESTRICTED' | 'FORBIDDEN',
  ) {
    super(code);
    this.name = 'GuildHolderContractError';
  }
}
