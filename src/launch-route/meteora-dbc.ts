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
const OPEN_DECISIONS = Object.freeze(['O02', 'O08']);
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

function fault(error: unknown): LaunchResult<never> {
  const code = error instanceof ProviderFault ? error.code : undefined;
  return fail(code && PROVIDER_CODES.has(code) ? code : 'PROVIDER_UNAVAILABLE');
}

export function createMeteoraDbcLaunchRoute(config: MeteoraDbcRouteConfig): LaunchRoute {
  if (!config || config.network !== 'DEVNET') throw new LaunchRouteError('NETWORK_REFUSED');
  const { client, now, economics } = config;
  const configured = economics !== undefined;

  const resolve = (request: LaunchRequest): LaunchResult<MeteoraParameters> => {
    if (!economics) return fail('NOT_CONFIGURED', OPEN_DECISIONS);
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
    if (!isPlain(economics) || typeof economics.decisionRef !== 'string' || !economics.decisionRef)
      return bad('ECONOMICS');
    if (economics.graduation !== 'DAMM_V2') return bad('GRADUATION');
    if (!isAddress(economics.feeClaimer)) return bad('FEE_CLAIMER');
    const params = economics.configParameters;
    if (!isPlain(params)) return bad('CONFIG_PARAMETERS');
    if ('quoteMint' in params && params.quoteMint !== METEORA_DBC_QUOTE_MINT)
      return bad('QUOTE_MINT');
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
    if (body === undefined) return bad('NON_CANONICAL');
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
        parameterHash: createHash('sha256').update(body).digest('hex'),
      } as const),
    );
  };

  /** NOT_CONFIGURED first, then the pin check: an intent from another route is never interpreted. */
  const pinned = (intent: PinnedLaunchIntent): LaunchResult<PinnedLaunchIntent> => {
    if (!economics) return fail('NOT_CONFIGURED', OPEN_DECISIONS);
    if (
      !intent ||
      intent.protocol !== 'METEORA_DBC' ||
      intent.programId !== METEORA_DBC_PROGRAM_ID ||
      intent.network !== 'DEVNET' ||
      intent.quoteMint !== METEORA_DBC_QUOTE_MINT ||
      !isAddress(intent.mint) ||
      !isAddress(intent.feeClaimer) ||
      !Number.isInteger(intent.transactionCount) ||
      intent.transactionCount < 1
    )
      return fail('PROTOCOL_MISMATCH');
    return ok(intent);
  };

  const matches = (intent: PinnedLaunchIntent, pool: MeteoraPoolObservation) =>
    pool.programId === intent.programId &&
    pool.mint === intent.mint &&
    pool.quoteMint === intent.quoteMint &&
    pool.feeClaimer === intent.feeClaimer;

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
    const states: string[] = [];
    try {
      for (const signature of signatures)
        states.push((await client.getTransactionStatus(signature)).state);
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
        programId: intent.programId,
        mint: intent.mint,
        pool: intent.pool,
        quoteMint: intent.quoteMint,
        feeClaimer: intent.feeClaimer,
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
        configured,
        openDecisions: configured ? Object.freeze([]) : OPEN_DECISIONS,
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
      try {
        const q = await client.quote(resolved.value);
        if (
          typeof q?.quoteId !== 'string' ||
          !q.quoteId ||
          Number.isNaN(Date.parse(q.expiresAt)) ||
          !isPlain(q.amounts)
        )
          return fail('INCONSISTENT_STATE');
        return ok(
          Object.freeze({
            quoteId: q.quoteId,
            expiresAt: q.expiresAt,
            parameterHash: resolved.value.parameterHash,
            amounts: Object.freeze({ ...q.amounts }),
          }),
        );
      } catch (error) {
        return fault(error);
      }
    },

    async prepareLaunch(request, quote): Promise<LaunchResult<PreparedLaunch>> {
      const resolved = resolve(request);
      if (!resolved.ok) return resolved;
      if (!quote || quote.parameterHash !== resolved.value.parameterHash)
        return fail('INCONSISTENT_STATE');
      const expires = Date.parse(quote.expiresAt);
      if (Number.isNaN(expires)) return fail('INCONSISTENT_STATE');
      if (now().getTime() >= expires) return fail('QUOTE_EXPIRED');
      try {
        const built = await client.buildUnsignedLaunch(resolved.value, quote.quoteId);
        if (
          !isAddress(built?.mint) ||
          !isAddress(built.pool) ||
          !Array.isArray(built.transactions) ||
          built.transactions.length < 1
        )
          return fail('INCONSISTENT_STATE');
        const intent: PinnedLaunchIntent = Object.freeze({
          protocol: 'METEORA_DBC',
          programId: METEORA_DBC_PROGRAM_ID,
          network: 'DEVNET',
          intentId: request.intentId,
          parameterHash: resolved.value.parameterHash,
          quoteMint: METEORA_DBC_QUOTE_MINT,
          feeClaimer: resolved.value.feeClaimer,
          founderWallet: resolved.value.founderWallet,
          mint: built.mint,
          pool: built.pool,
          quoteId: quote.quoteId,
          transactionCount: built.transactions.length,
        } as const);
        return ok(
          Object.freeze({
            signed: false as const,
            intent,
            transactions: Object.freeze(built.transactions.map((t) => Object.freeze({ ...t }))),
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

/** RED-stage stub: replaced by the recorded-decision registry in the GREEN commit. */
export function createMeteoraDbcLaunchRouteWithDecisions(
  config: MeteoraDbcRouteConfig,
  _recorded: readonly string[],
): LaunchRoute {
  return createMeteoraDbcLaunchRoute(config);
}
