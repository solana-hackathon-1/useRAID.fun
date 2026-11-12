// Standalone consuming host for the launch route adapter. Synthetic data only; no network, key,
// environment variable or Meteora SDK. The in-memory client stands in for a host-owned binding.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import {
  METEORA_DBC_PROGRAM_ID,
  METEORA_DBC_QUOTE_MINT,
  SOLANA_DEVNET_GENESIS_HASH,
  LaunchRouteError,
  createMeteoraDbcLaunchRoute,
  type LaunchResult,
  type LaunchRoute,
  type MeteoraDbcClient,
  type MeteoraPoolObservation,
} from './launch-route/index';
// Test seam, not in the package entry point: the public route has no recorded economics decision
// today (O02/O08 OPEN), so this host passes a synthetic reference to exercise a configured route.
import { createMeteoraDbcLaunchRouteWithDecisions } from './launch-route/meteora-dbc';

const addr = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill));
const [FOUNDER, FEE_CLAIMER, MINT, POOL, DAMM] = [11, 12, 13, 14, 15].map(addr);
const NOW = new Date('2026-11-07T12:00:00.000Z');
const request = {
  intentId: 'example-intent',
  founderWallet: FOUNDER,
  metadata: { name: 'Example Guild', symbol: 'EXG', uri: 'https://example.invalid/m.json' },
};

const DECISION = 'DEC-2030-01-01-01'; // synthetic; no recorded economics decision exists
const CONFIG = { poolCreationFee: 'host-supplied' };
const CONFIG_HASH = createHash('sha256')
  .update('{"poolCreationFee":"host-supplied"}')
  .digest('hex');
let genesis = SOLANA_DEVNET_GENESIS_HASH;
let pool: MeteoraPoolObservation | null = null;
const issued = new Map<
  string,
  { quoteId: string; expiresAt: string; parameterHash: string; amounts: Record<string, string> }
>();
const client: MeteoraDbcClient = {
  async getGenesisHash() {
    return genesis;
  },
  async quote(parameters) {
    const q = {
      quoteId: 'q',
      expiresAt: '2026-11-07T12:05:00.000Z',
      parameterHash: parameters.parameterHash,
      amounts: { fee: '7' },
    };
    issued.set(q.quoteId, q);
    return { quoteId: q.quoteId, expiresAt: q.expiresAt, amounts: q.amounts };
  },
  async getQuote(quoteId) {
    return issued.get(quoteId) ?? null;
  },
  async buildUnsignedLaunch(parameters, quoteId) {
    return {
      mint: MINT,
      pool: POOL,
      parameterHash: parameters.parameterHash,
      quoteId,
      amounts: issued.get(quoteId)?.amounts ?? {},
      transactions: [{ serializedBase64: 'AA==', description: 'create' }],
    };
  },
  async getTransactionStatus(signature) {
    return {
      signature,
      state: 'FINALIZED',
      programId: METEORA_DBC_PROGRAM_ID,
      mint: MINT,
      pool: POOL,
      signer: FOUNDER,
    };
  },
  async getPoolState() {
    return pool;
  },
};
const observed = (over: Partial<MeteoraPoolObservation> = {}): MeteoraPoolObservation => ({
  programId: METEORA_DBC_PROGRAM_ID,
  pool: POOL,
  mint: MINT,
  creator: FOUNDER,
  configHash: CONFIG_HASH,
  quoteMint: METEORA_DBC_QUOTE_MINT,
  feeClaimer: FEE_CLAIMER,
  migrationProgress: 0,
  quoteReserve: '0',
  migrationQuoteThreshold: '1',
  tokenUpdateAuthority: 'CREATOR',
  observedAt: '2026-11-07T12:00:01.000Z',
  ...over,
});

// The consumer only knows the LaunchRoute interface.
async function consume(route: LaunchRoute) {
  const quote = await route.quoteLaunch(request);
  if (!quote.ok) return { stage: 'quote', code: quote.error.code };
  const prepared = await route.prepareLaunch(request, quote.value);
  if (!prepared.ok) return { stage: 'prepare', code: prepared.error.code };
  const rec = await route.reconcileLaunch(prepared.value.intent, ['sig-1']);
  return rec.ok
    ? { stage: 'done', state: rec.value.launch.state, graduated: rec.value.market.graduated }
    : { stage: 'reconcile', code: rec.error.code };
}

// 1. No economics (O02, O08 OPEN): controlled NOT_CONFIGURED, provider untouched.
const bare = createMeteoraDbcLaunchRoute({ network: 'DEVNET', client, now: () => NOW });
const bareResult = await bare.validateLaunch(request);
const notConfiguredByDefault =
  !bare.capabilities().configured &&
  !bareResult.ok &&
  bareResult.error.code === 'NOT_CONFIGURED' &&
  bareResult.error.detail?.join(',') === 'O02,O08';

// 2. Mainnet is refused in code.
let mainnetRefused = false;
try {
  createMeteoraDbcLaunchRoute({ network: 'MAINNET' as never, client, now: () => NOW });
} catch (error) {
  mainnetRefused = error instanceof LaunchRouteError && error.code === 'NETWORK_REFUSED';
}

// 3. Host-supplied (here: synthetic placeholder) economics configure the route.
const economics = {
  decisionRef: DECISION,
  feeClaimer: FEE_CLAIMER,
  graduation: 'DAMM_V2' as const,
  configParameters: CONFIG,
};
const route = createMeteoraDbcLaunchRouteWithDecisions(
  { network: 'DEVNET', client, now: () => NOW, economics },
  [DECISION],
);
// The public entry point cannot be configured by a host: the recorded-decision list is empty.
const hostCannotConfigure = !createMeteoraDbcLaunchRoute({
  network: 'DEVNET',
  client,
  now: () => NOW,
  economics,
}).capabilities().configured;
const quote = await route.quoteLaunch(request);
assert.ok(quote.ok);
const prepared = await route.prepareLaunch(request, quote.value);
assert.ok(prepared.ok);
const intent = prepared.value.intent;
const wrong = await route.verifyLaunch({ ...intent, programId: addr(99) }, ['sig-1']);
const pinnedIntent =
  prepared.value.signed === false &&
  intent.protocol === 'METEORA_DBC' &&
  intent.programId === METEORA_DBC_PROGRAM_ID &&
  !wrong.ok &&
  wrong.error.code === 'PROTOCOL_MISMATCH';

// 4. LIVE only when finalized and the observed pool matches; a mismatch is INCONSISTENT_STATE.
pool = observed();
const live = await route.verifyLaunch(intent, ['sig-1']);
pool = observed({ feeClaimer: addr(80) });
const mismatch = await route.verifyLaunch(intent, ['sig-1']);
const liveOnlyWhenFinalizedAndMatching =
  live.ok &&
  live.value.state === 'LIVE' &&
  !mismatch.ok &&
  mismatch.error.code === 'INCONSISTENT_STATE';

// 5. Reaching the threshold or phase 1 is not graduation; only a created DAMM v2 pool is.
pool = observed({ migrationProgress: 0, quoteReserve: '5', migrationQuoteThreshold: '5' });
const atThreshold = await route.getMarketStatus(intent);
pool = observed({ migrationProgress: 3, dammV2Pool: DAMM });
const created = await route.getMarketStatus(intent);
const graduationNeedsCreatedPool =
  atThreshold.ok && !atThreshold.value.graduated && created.ok && created.value.graduated;

pool = observed({ migrationProgress: 3, dammV2Pool: DAMM });
// 5b. A forged quote and a non-devnet cluster are refused before anything is built or read.
const forged = await route.prepareLaunch(request, {
  ...quote.value,
  expiresAt: '2999-01-01T00:00:00.000Z',
});
genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const mainnetClient = await route.getMarketStatus(intent);
genesis = SOLANA_DEVNET_GENESIS_HASH;
const forgedQuoteAndMainnetClientRefused =
  !forged.ok &&
  forged.error.code === 'INCONSISTENT_STATE' &&
  !mainnetClient.ok &&
  mainnetClient.error.code === 'NETWORK_REFUSED';

// 6. An independent route behind the same interface (a recorded-replay stand-in) serves the same
// consumer with the same results; nothing in the consumer names Meteora.
const ok = <T>(value: T): LaunchResult<T> => ({ ok: true, value });
const replay: LaunchRoute = {
  capabilities: () => route.capabilities(),
  validateLaunch: async () => ok({ parameterHash: intent.parameterHash }),
  quoteLaunch: async () => ok(quote.value),
  prepareLaunch: async () => ok(prepared.value),
  verifyLaunch: async () =>
    ok({ state: 'LIVE' as const, facts: live.ok ? live.value.facts : (undefined as never) }),
  getMarketStatus: async () => (await route.getMarketStatus(intent)) as never,
  reconcileLaunch: async () =>
    ok({
      launch: { state: 'LIVE' as const, facts: live.ok ? live.value.facts : (undefined as never) },
      market: created.ok ? created.value : (undefined as never),
    }),
};
const substituteRouteSameResults =
  JSON.stringify(await consume(route)) === JSON.stringify(await consume(replay)) &&
  (await consume(route)).state === 'LIVE';

// 7. Failures carry codes only, never provider text.
const leaky = createMeteoraDbcLaunchRouteWithDecisions(
  {
    network: 'DEVNET',
    client: {
      ...client,
      async quote() {
        throw new Error('SECRET provider text');
      },
    },
    now: () => NOW,
    economics,
  },
  [DECISION],
);
const leakResult: LaunchResult<unknown> = await leaky.quoteLaunch(request);
const sanitizedFailure =
  !leakResult.ok &&
  leakResult.error.code === 'PROVIDER_UNAVAILABLE' &&
  !JSON.stringify(leakResult).includes('SECRET');

const result = {
  notConfiguredByDefault,
  hostCannotConfigure,
  mainnetRefused,
  pinnedIntent,
  liveOnlyWhenFinalizedAndMatching,
  graduationNeedsCreatedPool,
  forgedQuoteAndMainnetClientRefused,
  substituteRouteSameResults,
  sanitizedFailure,
};
assert.ok(Object.values(result).every((value) => value === true));
console.log(JSON.stringify(result));
