import type { LaunchRouteErrorCode } from './errors';

/** Failures are data: codes and fixed detail tokens only, never input or provider text. */
export interface LaunchRouteFailure {
  readonly code: LaunchRouteErrorCode;
  readonly detail?: readonly string[];
}
export type LaunchResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: LaunchRouteFailure };

/** Launch states from blueprint 05.3 that an adapter can establish from observations. */
export type LaunchState = 'SUBMITTED' | 'CONFIRMED_PENDING_FINALITY' | 'LIVE' | 'ACTION_REQUIRED';

export interface LaunchMetadata {
  name: string;
  symbol: string;
  uri: string;
}
/** Non-economic, founder-facing input. Supply, allocation, curve and fees are NOT part of it (O02, O08). */
export interface LaunchRequest {
  intentId: string;
  founderWallet: string;
  metadata: LaunchMetadata;
}

export interface LaunchQuote {
  readonly quoteId: string;
  readonly expiresAt: string;
  readonly parameterHash: string;
  /** Provider-quoted amounts as decimal base-unit strings. Never summed, priced or valued here. */
  readonly amounts: Readonly<Record<string, string>>;
}
export interface UnsignedTransaction {
  readonly serializedBase64: string;
  readonly description: string;
}
/** Everything that must never silently change once a founder has reviewed a launch (05.4). */
export interface PinnedLaunchIntent {
  readonly protocol: 'METEORA_DBC';
  readonly programId: string;
  readonly network: 'DEVNET';
  readonly intentId: string;
  readonly parameterHash: string;
  readonly quoteMint: string;
  readonly feeClaimer: string;
  readonly founderWallet: string;
  readonly mint: string;
  readonly pool: string;
  readonly quoteId: string;
  readonly transactionCount: number;
}
export interface PreparedLaunch {
  /** Always false: this module never signs. The founder's authorized wallet signs elsewhere. */
  readonly signed: false;
  readonly intent: PinnedLaunchIntent;
  readonly transactions: readonly UnsignedTransaction[];
}

export interface LaunchFacts {
  readonly protocol: 'METEORA_DBC';
  readonly network: 'DEVNET';
  readonly programId: string;
  readonly mint: string;
  readonly pool: string;
  readonly quoteMint: string;
  readonly feeClaimer: string;
  readonly parameterHash: string;
  readonly authorities: { readonly tokenUpdateAuthority: TokenUpdateAuthority };
  readonly transactionSignatures: readonly string[];
  readonly observedAt: string;
}
export interface VerifiedLaunch {
  readonly state: LaunchState;
  /** Present only when `state` is `LIVE`. */
  readonly facts: LaunchFacts;
}

export type MarketPhase =
  'NOT_FOUND' | 'PRE_BONDING_CURVE' | 'POST_BONDING_CURVE' | 'LOCKED_VESTING' | 'CREATED_POOL';
export interface MarketStatus {
  readonly phase: MarketPhase;
  /** True only when the provider reports the DAMM v2 pool as created. Never a progress bar. */
  readonly graduated: boolean;
  readonly quoteReserve: string | null;
  readonly migrationQuoteThreshold: string | null;
  readonly dammV2Pool: string | null;
  readonly observedAt: string | null;
}
export interface ReconciledLaunch {
  readonly launch: VerifiedLaunch;
  readonly market: MarketStatus;
}

export interface RouteCapabilities {
  readonly protocol: 'METEORA_DBC';
  readonly programId: string;
  readonly network: 'DEVNET';
  readonly quoteAsset: { readonly mint: string };
  readonly graduation: 'DAMM_V2';
  readonly configured: boolean;
  /** Names of OPEN decisions that keep the route unconfigured. */
  readonly openDecisions: readonly string[];
  readonly immutableMetadata: {
    readonly documented: boolean;
    readonly relied: boolean;
    readonly verifiedOnChain: boolean;
    readonly source: string;
  };
}

/** Replaceable launch route contract (docs/raid-module-reuse.md, launch route row). */
export interface LaunchRoute {
  capabilities(): RouteCapabilities;
  validateLaunch(request: LaunchRequest): Promise<LaunchResult<{ parameterHash: string }>>;
  quoteLaunch(request: LaunchRequest): Promise<LaunchResult<LaunchQuote>>;
  prepareLaunch(request: LaunchRequest, quote: LaunchQuote): Promise<LaunchResult<PreparedLaunch>>;
  verifyLaunch(
    intent: PinnedLaunchIntent,
    signatures: readonly string[],
  ): Promise<LaunchResult<VerifiedLaunch>>;
  getMarketStatus(intent: PinnedLaunchIntent): Promise<LaunchResult<MarketStatus>>;
  reconcileLaunch(
    intent: PinnedLaunchIntent,
    signatures: readonly string[],
  ): Promise<LaunchResult<ReconciledLaunch>>;
}

export type TokenUpdateAuthority =
  'CREATOR' | 'IMMUTABLE' | 'PARTNER' | 'CREATOR_AND_MINT' | 'PARTNER_AND_MINT';
export interface MeteoraTxObservation {
  signature: string;
  state: 'UNKNOWN' | 'PROCESSED' | 'CONFIRMED' | 'FINALIZED' | 'FAILED';
}
export interface MeteoraPoolObservation {
  programId: string;
  mint: string;
  quoteMint: string;
  feeClaimer: string;
  /** Meteora `MigrationProgress`: 0 PreBondingCurve, 1 PostBondingCurve, 2 LockedVesting, 3 CreatedPool. */
  migrationProgress: 0 | 1 | 2 | 3;
  quoteReserve: string;
  migrationQuoteThreshold: string;
  tokenUpdateAuthority: TokenUpdateAuthority;
  dammV2Pool?: string;
  observedAt: string;
}
export interface MeteoraParameters {
  readonly network: 'DEVNET';
  readonly programId: string;
  readonly quoteMint: string;
  readonly graduation: 'DAMM_V2';
  readonly feeClaimer: string;
  readonly founderWallet: string;
  readonly metadata: LaunchMetadata;
  readonly configParameters: Readonly<Record<string, unknown>>;
  readonly parameterHash: string;
}
/**
 * Port to Meteora (SDK or RPC). A real binding belongs to the host and is not shipped here. The
 * client builds unsigned transactions only; it never receives a key.
 */
export interface MeteoraDbcClient {
  quote(parameters: MeteoraParameters): Promise<{
    quoteId: string;
    expiresAt: string;
    amounts: Record<string, string>;
  }>;
  buildUnsignedLaunch(
    parameters: MeteoraParameters,
    quoteId: string,
  ): Promise<{ mint: string; pool: string; transactions: UnsignedTransaction[] }>;
  getTransactionStatus(signature: string): Promise<MeteoraTxObservation>;
  getPoolState(mint: string): Promise<MeteoraPoolObservation | null>;
}

/** Host-supplied economics from the future O02/O08 decision. This module ships no default. */
export interface MeteoraEconomics {
  /** Recorded owner decision that supplies these values. */
  decisionRef: string;
  /** Fee recipient the founder reviewed; verification refuses a different one. */
  feeClaimer: string;
  graduation: 'DAMM_V2';
  /** Opaque, canonical-JSON parameters passed to the client and hashed into the intent. */
  configParameters: Record<string, unknown>;
}
export interface MeteoraDbcRouteConfig {
  network: 'DEVNET';
  client: MeteoraDbcClient;
  now: () => Date;
  economics?: MeteoraEconomics;
}
