// Standalone consuming host for the launch route adapter. Synthetic data only; no network, key,
// environment variable or Meteora SDK. The in-memory client stands in for a host-owned binding.
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {
  METEORA_DBC_PROGRAM_ID,
  METEORA_DBC_QUOTE_MINT,
  LaunchRouteError,
  createMeteoraDbcLaunchRoute,
  type LaunchResult,
  type LaunchRoute,
  type MeteoraDbcClient,
  type MeteoraPoolObservation,
} from './launch-route/index';

const addr = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill));
const [FOUNDER, FEE_CLAIMER, MINT, POOL, DAMM] = [11, 12, 13, 14, 15].map(addr);
const NOW = new Date('2026-11-07T12:00:00.000Z');
const request = {
  intentId: 'example-intent',
  founderWallet: FOUNDER,
  metadata: { name: 'Example Guild', symbol: 'EXG', uri: 'https://example.invalid/m.json' },
};

let pool: MeteoraPoolObservation | null = null;
const client: MeteoraDbcClient = {
  async quote() {
    return { quoteId: 'q', expiresAt: '2026-11-07T12:05:00.000Z', amounts: {} };
  },
  async buildUnsignedLaunch() {
    return {
      mint: MINT,
      pool: POOL,
      transactions: [{ serializedBase64: 'AA==', description: 'create' }],
    };
  },
  async getTransactionStatus(signature) {
    return { signature, state: 'FINALIZED' };
  },
  async getPoolState() {
    return pool;
  },
};
const observed = (over: Partial<MeteoraPoolObservation> = {}): MeteoraPoolObservation => ({
  programId: METEORA_DBC_PROGRAM_ID,
  mint: MINT,
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
const route = createMeteoraDbcLaunchRoute({
  network: 'DEVNET',
  client,
  now: () => NOW,
  economics: {
    decisionRef: 'example-only-decision',
    feeClaimer: FEE_CLAIMER,
    graduation: 'DAMM_V2',
    configParameters: { placeholder: 'host-supplied' },
  },
});
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
const leaky = createMeteoraDbcLaunchRoute({
  network: 'DEVNET',
  client: {
    ...client,
    async quote() {
      throw new Error('SECRET provider text');
    },
  },
  now: () => NOW,
  economics: {
    decisionRef: 'x',
    feeClaimer: FEE_CLAIMER,
    graduation: 'DAMM_V2',
    configParameters: {},
  },
});
const leakResult: LaunchResult<unknown> = await leaky.quoteLaunch(request);
const sanitizedFailure =
  !leakResult.ok &&
  leakResult.error.code === 'PROVIDER_UNAVAILABLE' &&
  !JSON.stringify(leakResult).includes('SECRET');

const result = {
  notConfiguredByDefault,
  mainnetRefused,
  pinnedIntent,
  liveOnlyWhenFinalizedAndMatching,
  graduationNeedsCreatedPool,
  substituteRouteSameResults,
  sanitizedFailure,
};
assert.ok(Object.values(result).every((value) => value === true));
console.log(JSON.stringify(result));
