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
  /** SHA-256 of the canonical `configParameters`; the observed on-chain config must reproduce it. */
  readonly configHash: string;
  readonly quoteMint: string;
  readonly feeClaimer: string;
  readonly founderWallet: string;
  readonly mint: string;
  readonly pool: string;
  readonly quoteId: string;
  readonly transactionCount: number;
  /** SHA-256 over the canonical list of the unsigned transactions the founder reviewed. */
  readonly transactionsDigest: string;
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
  /** Observed on-chain creator; equals the pinned founder wallet. */
  readonly creator: string;
  /** Observed on-chain config hash; equals the pinned `configHash`. */
  readonly configHash: string;
  /** The pinned, reviewed parameter hash (a pin, not an observation; bound through `configHash`). */
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
  /** Echo of the queried signature; a different one is refused. */
  signature: string;
  state: 'UNKNOWN' | 'PROCESSED' | 'CONFIRMED' | 'FINALIZED' | 'FAILED';
  /**
   * Binding of a known transaction to the launch: DBC program invoked, mint and pool it touches and
   * its fee payer/signer. Required unless `state` is `UNKNOWN`; each must equal the pinned intent.
   */
  programId?: string;
  mint?: string;
  pool?: string;
  signer?: string;
}
export interface MeteoraPoolObservation {
  programId: string;
  /** The DBC pool account (`virtual_pool`) read on chain. */
  pool: string;
  mint: string;
  /** On-chain creator of the pool. */
  creator: string;
  /**
   * SHA-256 of the canonical JSON of the configuration parameters as read from the on-chain config
   * account, computed by the host binding exactly like the route hashes `configParameters`.
   */
  configHash: string;
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
  readonly configHash: string;
  readonly parameterHash: string;
}
/** The provider's authoritative record of an issued quote. */
export interface ProviderQuote {
  quoteId: string;
  expiresAt: string;
  parameterHash: string;
  amounts: Record<string, string>;
}
/** Unsigned build result; it must echo the parameters and quote it was built for. */
export interface UnsignedLaunchBuild {
  mint: string;
  pool: string;
  parameterHash: string;
  quoteId: string;
  amounts: Record<string, string>;
  transactions: UnsignedTransaction[];
}
/**
 * Port to Meteora (SDK or RPC). A real binding belongs to the host and is not shipped here. The
 * client builds unsigned transactions only; it never receives a key.
 */
export interface MeteoraDbcClient {
  /** Genesis hash of the cluster this client talks to; the route refuses anything but devnet. */
  getGenesisHash(): Promise<string>;
  quote(parameters: MeteoraParameters): Promise<{
    quoteId: string;
    expiresAt: string;
    amounts: Record<string, string>;
  }>;
  /** Provider-side record of `quoteId`, or null when unknown. The route trusts this, not the caller. */
  getQuote(quoteId: string): Promise<ProviderQuote | null>;
  buildUnsignedLaunch(parameters: MeteoraParameters, quoteId: string): Promise<UnsignedLaunchBuild>;
  getTransactionStatus(signature: string): Promise<MeteoraTxObservation>;
  getPoolState(mint: string): Promise<MeteoraPoolObservation | null>;
}

/** Host-supplied economics from the future O02/O08 decision. This module ships no default. */
export interface MeteoraEconomics {
  /**
   * Reference (`DEC-YYYY-MM-DD-NN`) to the recorded owner decision that supplies these values. It
   * only counts when it is in `RECORDED_ECONOMICS_DECISIONS`, which is empty while O02/O08 are OPEN.
   */
  decisionRef: string;
  /** Fee recipient the founder reviewed; verification refuses a different one. */
  feeClaimer: string;
  graduation: 'DAMM_V2';
  /**
   * Canonical-JSON parameters passed to the client and hashed into the intent. Rejected at any
   * depth: another quote asset, a migration target other than DAMM v2, and custom-curve keys.
   */
  configParameters: Record<string, unknown>;
}
export interface MeteoraDbcRouteConfig {
  network: 'DEVNET';
  client: MeteoraDbcClient;
  now: () => Date;
  economics?: MeteoraEconomics;
}
