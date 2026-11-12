import { createHash } from 'node:crypto';
import { SolanaAddress } from '../contracts/assets';
import { LaunchRouteError, ProviderFault, type LaunchRouteErrorCode } from './errors';
import type {
  LaunchFacts,
  LaunchQuote,
  LaunchRequest,
  LaunchResult,
  LaunchRoute,
  LaunchState,
  MarketPhase,
  MarketStatus,
  MeteoraDbcRouteConfig,
  MeteoraParameters,
  MeteoraPoolObservation,
  MeteoraTxObservation,
  PinnedLaunchIntent,
  PreparedLaunch,
  ReconciledLaunch,
  RouteCapabilities,
  VerifiedLaunch,
} from './types';

/**
 * Meteora Dynamic Bonding Curve to DAMM v2 launch route (DEC-2026-11-07-04, O01), devnet only.
 *
 * Program id: Meteora documents the same DBC program on Mainnet Beta and Devnet
 * (https://docs.meteora.ag/developer-guides/dbc). Quote asset is devnet USDC. Supply, allocation,
 * curve and fees are OPEN (O02, O08): this module supplies none and reports NOT_CONFIGURED until a
 * host provides economics from a recorded decision. It never signs or sends a transaction and
 * imports no SDK; a host-owned client port builds unsigned transactions and reads state.
 */
export const METEORA_DBC_PROGRAM_ID = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
/** Devnet USDC. Equals `USDC_MINTS.devnet` in src/lib/usdc.ts; a test pins that (no app import here). */
export const METEORA_DBC_QUOTE_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const METEORA_IMMUTABLE_METADATA_SOURCE =
  'https://docs.meteora.ag/developer-guides/dbc/program/accounts';
/**
 * Genesis hash of Solana devnet. The client must report exactly this before any call (the other
 * network hashes, including mainnet-beta, are refused with `NETWORK_REFUSED`).
 */
export const SOLANA_DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
/**
 * Recorded owner decisions (`DEC-YYYY-MM-DD-NN`) that supply launch economics. Empty while O02 and
 * O08 are OPEN: no value passes, so the route stays NOT_CONFIGURED. Not exported from the package
 * entry point, which always uses this list, so a host cannot widen it; tests use
 * `createMeteoraDbcLaunchRouteWithDecisions` from this file with synthetic references.
 */
export const RECORDED_ECONOMICS_DECISIONS: readonly string[] = Object.freeze([]);
const DECISION_REF = /^DEC-\d{4}-\d{2}-\d{2}-\d{2}$/;
const OPEN_DECISIONS = Object.freeze(['O02', 'O08']);
const SHA256 = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const AMOUNT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const AMOUNT_VALUE = /^(0|[1-9][0-9]{0,38})$/;
const MAX_TRANSACTIONS = 8;
/** On-chain `PoolConfig.curve` capacity (`MAX_CURVE_POINT_CONFIG`). */
const MAX_CURVE_POINTS = 20;
/**
 * Allow-list of `configParameters` (the Meteora `ConfigParameters` struct). A node is `SCALAR`
 * (string, finite number, boolean or null), an object listing every key it may hold, or a list of
 * such objects. Any other key at any depth, and any other shape, is refused: the route never
 * forwards a field it was not told about, so a custom curve or program cannot hide under an
 * unlisted name. Names come from Meteora's documentation (program snake_case, SDK camelCase):
 * <https://docs.meteora.ag/developer-guides/dbc/typescript-sdk/reference.md> and the program accounts
 * page. The quote mint is not a field: the route pins devnet USDC. Values stay with O02 and O08.
 * Adding a name needs a reviewed change.
 */
const SCALAR = 'scalar';
interface ObjectShape {
  readonly [key: string]: Shape;
}
interface ListShape {
  readonly list: ObjectShape;
  readonly max: number;
}
type Shape = typeof SCALAR | ObjectShape | ListShape;
const scalars = (...keys: string[]): ObjectShape =>
  Object.freeze(Object.fromEntries(keys.map((key) => [key, SCALAR] as const)));
const CONFIG_SHAPE: ObjectShape = Object.freeze({
  poolFees: Object.freeze({
    baseFee: scalars(
      'cliffFeeNumerator',
      'firstFactor',
      'secondFactor',
      'thirdFactor',
      'baseFeeMode',
    ),
    dynamicFee: scalars(
      'binStep',
      'binStepU128',
      'filterPeriod',
      'decayPeriod',
      'reductionFactor',
      'variableFeeControl',
      'maxVolatilityAccumulator',
    ),
  }),
  collectFeeMode: SCALAR,
  migrationOption: SCALAR,
  activationType: SCALAR,
  tokenType: SCALAR,
  tokenDecimal: SCALAR,
  partnerLiquidityPercentage: SCALAR,
  creatorLiquidityPercentage: SCALAR,
  partnerPermanentLockedLiquidityPercentage: SCALAR,
  creatorPermanentLockedLiquidityPercentage: SCALAR,
  migrationQuoteThreshold: SCALAR,
  sqrtStartPrice: SCALAR,
  lockedVesting: scalars(
    'amountPerPeriod',
    'cliffDurationFromMigrationTime',
    'frequency',
    'numberOfPeriod',
    'cliffUnlockAmount',
    'totalLockedVestingAmount',
    'numberOfVestingPeriod',
    'totalVestingDuration',
  ),
  migrationFeeOption: SCALAR,
  migrationFee: scalars('feePercentage', 'creatorFeePercentage'),
  tokenSupply: scalars('preMigrationTokenSupply', 'postMigrationTokenSupply'),
  creatorTradingFeePercentage: SCALAR,
  tokenAuthorityOption: SCALAR,
  migratedPoolFee: scalars('collectFeeMode', 'dynamicFee', 'poolFeeBps', 'compoundingFeeBps'),
  poolCreationFee: SCALAR,
  partnerLiquidityVestingInfo: scalars(
    'vestingPercentage',
    'bpsPerPeriod',
    'numberOfPeriods',
    'cliffDurationFromMigrationTime',
    'totalDuration',
  ),
  creatorLiquidityVestingInfo: scalars(
    'vestingPercentage',
    'bpsPerPeriod',
    'numberOfPeriods',
    'cliffDurationFromMigrationTime',
    'totalDuration',
  ),
  migratedPoolBaseFeeMode: SCALAR,
  migratedPoolMarketCapFeeSchedulerParams: scalars(
    'endingBaseFeeBps',
    'numberOfPeriod',
    'priceMultiple',
    'schedulerExpirationDuration',
  ),
  enableFirstSwapWithMinFee: SCALAR,
  compoundingFeeBps: SCALAR,
  curve: Object.freeze({ list: scalars('sqrtPrice', 'liquidity'), max: MAX_CURVE_POINTS }),
});
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const PHASES: Record<number, MarketPhase> = {
  0: 'PRE_BONDING_CURVE',
  1: 'POST_BONDING_CURVE',
  2: 'LOCKED_VESTING',
  3: 'CREATED_POOL',
};
const PROVIDER_CODES: ReadonlySet<string> = new Set([
  'INSUFFICIENT_FUNDS',
  'UNSUPPORTED_PARAMETERS',
  'SIGNATURE_REJECTED',
  'PROVIDER_UNAVAILABLE',
]);

const fail = (code: LaunchRouteErrorCode, detail?: readonly string[]): LaunchResult<never> =>
  Object.freeze({
    ok: false,
    error: Object.freeze(detail ? { code, detail: Object.freeze([...detail]) } : { code }),
  });
const ok = <T>(value: T): LaunchResult<T> => Object.freeze({ ok: true, value });
const isAddress = (v: unknown): v is string =>
  typeof v === 'string' && SolanaAddress.safeParse(v).success;
const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;

/** Canonical JSON with sorted keys; undefined if anything is not plain JSON data. */
function canonical(value: unknown): string | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (Array.isArray(value)) {
    const parts = value.map(canonical);
    return parts.includes(undefined) ? undefined : `[${parts.join(',')}]`;
  }
  if (isPlain(value)) {
    const parts: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const inner = canonical(value[key]);
      if (inner === undefined) return undefined;
      parts.push(`${JSON.stringify(key)}:${inner}`);
    }
    return `{${parts.join(',')}}`;
  }
  return undefined;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const isScalar = (v: unknown) =>
  v === null ||
  typeof v === 'string' ||
  typeof v === 'boolean' ||
  (typeof v === 'number' && Number.isFinite(v));

/** Walks `value` against `shape`; returns a fixed violation token, or undefined when it conforms. */
function shapeViolation(value: unknown, shape: Shape): string | undefined {
  if (shape === SCALAR) return isScalar(value) ? undefined : 'SHAPE';
  if ('list' in shape && typeof shape.max === 'number') {
    if (!Array.isArray(value) || value.length > shape.max) return 'SHAPE';
    for (const item of value) {
      const found = shapeViolation(item, shape.list);
      if (found) return found;
    }
    return undefined;
  }
  if (!isPlain(value)) return 'SHAPE';
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(shape, key)) return 'UNKNOWN_KEY';
    const found = shapeViolation(value[key], (shape as ObjectShape)[key]);
    if (found) return found;
  }
  return undefined;
}

/**
 * `configParameters` must match `CONFIG_SHAPE` exactly (allow-list, fail closed), and the migration
 * target must be DAMM v2 (`migrationOption` 1 or `DAMM_V2`). The quote asset is not a parameter.
 */
function configViolation(root: unknown): string | undefined {
  const found = shapeViolation(root, CONFIG_SHAPE);
  if (found) return found;
  const migration = (root as Record<string, unknown>).migrationOption;
  if (migration !== undefined && migration !== 1 && migration !== 'DAMM_V2') return 'MIGRATION';
  return undefined;
}

/** Decimal base-unit strings only, bounded; undefined if anything else. */
function cleanAmounts(value: unknown): Record<string, string> | undefined {
  if (!isPlain(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length > 32) return undefined;
  const out: Record<string, string> = {};
  for (const key of keys) {
    const amount = value[key];
    if (!AMOUNT_KEY.test(key) || typeof amount !== 'string' || !AMOUNT_VALUE.test(amount))
      return undefined;
    out[key] = amount;
  }
  return out;
}

function fault(error: unknown): LaunchResult<never> {
  const code = error instanceof ProviderFault ? error.code : undefined;
  return fail(code && PROVIDER_CODES.has(code) ? code : 'PROVIDER_UNAVAILABLE');
}

/** Public entry point: always the (currently empty) recorded-decision registry. */
export function createMeteoraDbcLaunchRoute(config: MeteoraDbcRouteConfig): LaunchRoute {
  return createRoute(config, RECORDED_ECONOMICS_DECISIONS);
}
/** Not in the package entry point: lets tests exercise a configured route with synthetic decisions. */
export function createMeteoraDbcLaunchRouteWithDecisions(
  config: MeteoraDbcRouteConfig,
  recorded: readonly string[],
): LaunchRoute {
  return createRoute(config, recorded);
}

function createRoute(config: MeteoraDbcRouteConfig, recordedList: readonly string[]): LaunchRoute {
  if (!config || config.network !== 'DEVNET') throw new LaunchRouteError('NETWORK_REFUSED');
  const { client, now, economics } = config;
  const recorded: ReadonlySet<string> = new Set(recordedList);
  /** Evaluated on every call so a mutated or unrecorded decision reference never stays configured. */
  const isConfigured = () =>
    isPlain(economics) &&
    typeof economics.decisionRef === 'string' &&
    DECISION_REF.test(economics.decisionRef) &&
    recorded.has(economics.decisionRef);

  /** Refuses any client that is not on devnet; runs before every provider call, every time. */
  const onDevnet = async (): Promise<LaunchResult<never> | undefined> => {
    let genesis: unknown;
    try {
      genesis = await client.getGenesisHash();
    } catch (error) {
      return fault(error);
    }
    return genesis === SOLANA_DEVNET_GENESIS_HASH ? undefined : fail('NETWORK_REFUSED');
  };

  const resolve = (request: LaunchRequest): LaunchResult<MeteoraParameters> => {
    if (!economics || !isConfigured()) return fail('NOT_CONFIGURED', OPEN_DECISIONS);
    const bad = (token: string) => fail('UNSUPPORTED_PARAMETERS', [token]);
    if (!request || typeof request !== 'object') return bad('REQUEST');
    if (typeof request.intentId !== 'string' || !ID.test(request.intentId)) return bad('INTENT_ID');
    if (!isAddress(request.founderWallet)) return bad('FOUNDER_WALLET');
    const meta = request.metadata;
    if (!meta || typeof meta !== 'object') return bad('METADATA');
    for (const field of ['name', 'symbol'] as const) {
      const text = meta[field];
      if (typeof text !== 'string' || text.trim() !== text || text.length < 1 || text.length > 200)
        return bad(`METADATA_${field.toUpperCase()}`);
    }
    if (
      typeof meta.uri !== 'string' ||
      meta.uri.length > 400 ||
      !/^(https:\/\/|ipfs:\/\/)\S+$/.test(meta.uri)
    )
      return bad('METADATA_URI');
    if (economics.graduation !== 'DAMM_V2') return bad('GRADUATION');
    if (!isAddress(economics.feeClaimer)) return bad('FEE_CLAIMER');
    const params = economics.configParameters;
    if (!isPlain(params)) return bad('CONFIG_PARAMETERS');
    const violation = configViolation(params);
    if (violation) return bad(violation);
    const body = canonical({
      protocol: 'METEORA_DBC',
      network: 'DEVNET',
      programId: METEORA_DBC_PROGRAM_ID,
      quoteMint: METEORA_DBC_QUOTE_MINT,
      graduation: economics.graduation,
      feeClaimer: economics.feeClaimer,
      founderWallet: request.founderWallet,
      metadata: { name: meta.name, symbol: meta.symbol, uri: meta.uri },
      configParameters: params,
    });
    const configBody = canonical(params);
    if (body === undefined || configBody === undefined) return bad('NON_CANONICAL');
    return ok(
      Object.freeze({
        network: 'DEVNET',
        programId: METEORA_DBC_PROGRAM_ID,
        quoteMint: METEORA_DBC_QUOTE_MINT,
        graduation: 'DAMM_V2',
        feeClaimer: economics.feeClaimer,
        founderWallet: request.founderWallet,
        metadata: Object.freeze({ name: meta.name, symbol: meta.symbol, uri: meta.uri }),
        configParameters: params,
        configHash: sha256(configBody),
        parameterHash: sha256(body),
      } as const),
    );
  };

  /** NOT_CONFIGURED first, then the pin check: an intent from another route is never interpreted. */
  const pinned = (intent: PinnedLaunchIntent): LaunchResult<PinnedLaunchIntent> => {
    if (!isConfigured()) return fail('NOT_CONFIGURED', OPEN_DECISIONS);
    if (
      !intent ||
      intent.protocol !== 'METEORA_DBC' ||
      intent.programId !== METEORA_DBC_PROGRAM_ID ||
      intent.network !== 'DEVNET' ||
      intent.quoteMint !== METEORA_DBC_QUOTE_MINT ||
      !isAddress(intent.mint) ||
      !isAddress(intent.pool) ||
      !isAddress(intent.feeClaimer) ||
      !isAddress(intent.founderWallet) ||
      typeof intent.parameterHash !== 'string' ||
      !SHA256.test(intent.parameterHash) ||
      typeof intent.configHash !== 'string' ||
      !SHA256.test(intent.configHash) ||
      typeof intent.transactionsDigest !== 'string' ||
      !SHA256.test(intent.transactionsDigest) ||
      !Number.isInteger(intent.transactionCount) ||
      intent.transactionCount < 1
    )
      return fail('PROTOCOL_MISMATCH');
    return ok(intent);
  };

  const matches = (intent: PinnedLaunchIntent, pool: MeteoraPoolObservation) =>
    pool.programId === intent.programId &&
    pool.pool === intent.pool &&
    pool.mint === intent.mint &&
    pool.quoteMint === intent.quoteMint &&
    pool.feeClaimer === intent.feeClaimer &&
    pool.creator === intent.founderWallet &&
    pool.configHash === intent.configHash;

  /** A known transaction must be this launch's: program, mint, pool and signer equal the pin. */
  const bound = (intent: PinnedLaunchIntent, signature: string, tx: MeteoraTxObservation) =>
    !!tx &&
    tx.signature === signature &&
    (tx.state === 'UNKNOWN' ||
      (tx.programId === intent.programId &&
        tx.mint === intent.mint &&
        tx.pool === intent.pool &&
        tx.signer === intent.founderWallet));

  const market = (pool: MeteoraPoolObservation | null): MarketStatus =>
    Object.freeze(
      pool
        ? {
            phase: PHASES[pool.migrationProgress] ?? 'NOT_FOUND',
            graduated: pool.migrationProgress === 3 && typeof pool.dammV2Pool === 'string',
            quoteReserve: pool.quoteReserve,
            migrationQuoteThreshold: pool.migrationQuoteThreshold,
            dammV2Pool: pool.dammV2Pool ?? null,
            observedAt: pool.observedAt,
          }
        : {
            phase: 'NOT_FOUND' as const,
            graduated: false,
            quoteReserve: null,
            migrationQuoteThreshold: null,
            dammV2Pool: null,
            observedAt: null,
          },
    );

  async function getMarketStatus(intent: PinnedLaunchIntent): Promise<LaunchResult<MarketStatus>> {
    const pin = pinned(intent);
    if (!pin.ok) return pin;
    const refused = await onDevnet();
    if (refused) return refused;
    let pool: MeteoraPoolObservation | null;
    try {
      pool = await client.getPoolState(intent.mint);
    } catch (error) {
      return fault(error);
    }
    if (pool && !matches(intent, pool)) return fail('INCONSISTENT_STATE');
    return ok(market(pool));
  }

  async function verifyLaunch(
    intent: PinnedLaunchIntent,
    signatures: readonly string[],
  ): Promise<LaunchResult<VerifiedLaunch>> {
    const pin = pinned(intent);
    if (!pin.ok) return pin;
    if (
      !Array.isArray(signatures) ||
      signatures.length < 1 ||
      signatures.length > intent.transactionCount ||
      signatures.some((s) => typeof s !== 'string' || !s || s.length > 200) ||
      new Set(signatures).size !== signatures.length
    )
      return fail('UNSUPPORTED_PARAMETERS', ['SIGNATURES']);
    const refused = await onDevnet();
    if (refused) return refused;
    const states: string[] = [];
    try {
      for (const signature of signatures) {
        const tx = await client.getTransactionStatus(signature);
        if (!bound(intent, signature, tx)) return fail('INCONSISTENT_STATE');
        states.push(tx.state);
      }
    } catch (error) {
      return fault(error);
    }
    const count = (s: string) => states.filter((x) => x === s).length;
    const progressed = states.length - count('FAILED') - count('UNKNOWN');
    const shell = (state: LaunchState, facts?: LaunchFacts): LaunchResult<VerifiedLaunch> =>
      ok(Object.freeze({ state, facts: facts as LaunchFacts }));
    if (count('FAILED') > 0)
      return fail(progressed > 0 ? 'PARTIAL_COMPLETION' : 'TRANSACTION_FAILED');
    if (count('UNKNOWN') === states.length) return fail('TRANSACTION_UNKNOWN');
    if (count('UNKNOWN') > 0) return shell('SUBMITTED');
    if (count('FINALIZED') !== states.length) return shell('CONFIRMED_PENDING_FINALITY');
    if (signatures.length < intent.transactionCount) return shell('ACTION_REQUIRED');
    let pool: MeteoraPoolObservation | null;
    try {
      pool = await client.getPoolState(intent.mint);
    } catch (error) {
      return fault(error);
    }
    if (!pool || !matches(intent, pool)) return fail('INCONSISTENT_STATE');
    return shell(
      'LIVE',
      Object.freeze({
        protocol: 'METEORA_DBC',
        network: 'DEVNET',
        programId: pool.programId,
        mint: pool.mint,
        pool: pool.pool,
        quoteMint: pool.quoteMint,
        feeClaimer: pool.feeClaimer,
        creator: pool.creator,
        configHash: pool.configHash,
        parameterHash: intent.parameterHash,
        authorities: Object.freeze({ tokenUpdateAuthority: pool.tokenUpdateAuthority }),
        transactionSignatures: Object.freeze([...signatures]),
        observedAt: pool.observedAt,
      } as const),
    );
  }

  const route: LaunchRoute = {
    capabilities(): RouteCapabilities {
      return Object.freeze({
        protocol: 'METEORA_DBC',
        programId: METEORA_DBC_PROGRAM_ID,
        network: 'DEVNET',
        quoteAsset: Object.freeze({ mint: METEORA_DBC_QUOTE_MINT }),
        graduation: 'DAMM_V2',
        configured: isConfigured(),
        openDecisions: isConfigured() ? Object.freeze([]) : OPEN_DECISIONS,
        // Documented by Meteora (TokenAuthorityOption value 1, "immutable") but not exercised on
        // devnet by RAID, so nothing relies on it (DEC-2026-11-07-04).
        immutableMetadata: Object.freeze({
          documented: true,
          relied: false,
          verifiedOnChain: false,
          source: METEORA_IMMUTABLE_METADATA_SOURCE,
        }),
      } as const);
    },

    async validateLaunch(request) {
      const resolved = resolve(request);
      return resolved.ok ? ok({ parameterHash: resolved.value.parameterHash }) : resolved;
    },

    async quoteLaunch(request): Promise<LaunchResult<LaunchQuote>> {
      const resolved = resolve(request);
      if (!resolved.ok) return resolved;
      const refused = await onDevnet();
      if (refused) return refused;
      try {
        const q = await client.quote(resolved.value);
        const amounts = cleanAmounts(q?.amounts);
        if (
          typeof q?.quoteId !== 'string' ||
          !ID.test(q.quoteId) ||
          typeof q.expiresAt !== 'string' ||
          Number.isNaN(Date.parse(q.expiresAt)) ||
          !amounts
        )
          return fail('INCONSISTENT_STATE');
        return ok(
          Object.freeze({
            quoteId: q.quoteId,
            expiresAt: q.expiresAt,
            parameterHash: resolved.value.parameterHash,
            amounts: Object.freeze(amounts),
          }),
        );
      } catch (error) {
        return fault(error);
      }
    },

    /**
     * The caller's quote is never trusted: it must equal the provider's own record of that quote
     * (re-read here), recomputed against these parameters, and expiry comes from that record.
     */
    async prepareLaunch(request, quote): Promise<LaunchResult<PreparedLaunch>> {
      const resolved = resolve(request);
      if (!resolved.ok) return resolved;
      const claimed = cleanAmounts(quote?.amounts);
      if (
        !isPlain(quote) ||
        typeof quote.quoteId !== 'string' ||
        !ID.test(quote.quoteId) ||
        quote.parameterHash !== resolved.value.parameterHash ||
        typeof quote.expiresAt !== 'string' ||
        !claimed
      )
        return fail('INCONSISTENT_STATE');
      const refused = await onDevnet();
      if (refused) return refused;
      try {
        const record = await client.getQuote(quote.quoteId);
        const recorded = cleanAmounts(record?.amounts);
        if (
          !record ||
          record.quoteId !== quote.quoteId ||
          record.parameterHash !== resolved.value.parameterHash ||
          record.expiresAt !== quote.expiresAt ||
          !recorded ||
          canonical(recorded) !== canonical(claimed)
        )
          return fail('INCONSISTENT_STATE');
        const expires = Date.parse(record.expiresAt);
        const current = now().getTime();
        if (Number.isNaN(expires) || Number.isNaN(current)) return fail('INCONSISTENT_STATE');
        if (current >= expires) return fail('QUOTE_EXPIRED');
        const built = await client.buildUnsignedLaunch(resolved.value, quote.quoteId);
        const builtAmounts = cleanAmounts(built?.amounts);
        if (
          !isPlain(built) ||
          !isAddress(built.mint) ||
          !isAddress(built.pool) ||
          built.mint === built.pool ||
          built.parameterHash !== resolved.value.parameterHash ||
          built.quoteId !== quote.quoteId ||
          !builtAmounts ||
          canonical(builtAmounts) !== canonical(recorded) ||
          !Array.isArray(built.transactions) ||
          built.transactions.length < 1 ||
          built.transactions.length > MAX_TRANSACTIONS ||
          !built.transactions.every(
            (t) =>
              isPlain(t) &&
              typeof t.serializedBase64 === 'string' &&
              t.serializedBase64.length >= 4 &&
              t.serializedBase64.length <= 2048 &&
              t.serializedBase64.length % 4 === 0 &&
              BASE64.test(t.serializedBase64) &&
              typeof t.description === 'string' &&
              t.description.length >= 1 &&
              t.description.length <= 200,
          )
        )
          return fail('INCONSISTENT_STATE');
        const transactions = built.transactions.map((t) =>
          Object.freeze({ serializedBase64: t.serializedBase64, description: t.description }),
        );
        const digest = canonical(transactions.map((t) => [t.serializedBase64, t.description]));
        if (digest === undefined) return fail('INCONSISTENT_STATE');
        const intent: PinnedLaunchIntent = Object.freeze({
          protocol: 'METEORA_DBC',
          programId: METEORA_DBC_PROGRAM_ID,
          network: 'DEVNET',
          intentId: request.intentId,
          parameterHash: resolved.value.parameterHash,
          configHash: resolved.value.configHash,
          quoteMint: METEORA_DBC_QUOTE_MINT,
          feeClaimer: resolved.value.feeClaimer,
          founderWallet: resolved.value.founderWallet,
          mint: built.mint,
          pool: built.pool,
          quoteId: quote.quoteId,
          transactionCount: transactions.length,
          transactionsDigest: sha256(digest),
        } as const);
        return ok(
          Object.freeze({
            signed: false as const,
            intent,
            transactions: Object.freeze(transactions),
          }),
        );
      } catch (error) {
        return fault(error);
      }
    },

    verifyLaunch,
    getMarketStatus,

    async reconcileLaunch(intent, signatures): Promise<LaunchResult<ReconciledLaunch>> {
      const launch = await verifyLaunch(intent, signatures);
      if (!launch.ok) return launch;
      const status = await getMarketStatus(intent);
      if (!status.ok) return status;
      return ok(Object.freeze({ launch: launch.value, market: status.value }));
    },
  };
  return Object.freeze(route);
}
