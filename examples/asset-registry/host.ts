// Standalone consuming host for the asset registry. It declares every input itself: no RAID
// config, database, session, environment variable or provider is imported or read.
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {
  AssetRegistryError,
  PRODUCTION_ASSET_ALLOWLIST,
  SPL_TOKEN_PROGRAM_ID,
  createAssetRegistry,
  createProductionAssetRegistry,
  evaluateRewardFunding,
  formatAmount,
  fromJsonAmount,
  parseAmount,
  splitProportional,
  toJsonAmount,
  type AssetRegistryInput,
} from './asset-registry/index';
import { assetKey } from './contracts/index';

// Synthetic, test-only addresses: valid 32-byte base58 keys that are not real mints.
const fill = (value: number) => bs58.encode(new Uint8Array(32).fill(value));
const NETWORK = 'synthetic-example-network';
const OTHER_NETWORK = 'synthetic-other-network';
const token = (mint: string, networkIdentity = NETWORK) => ({
  chain: 'SOLANA' as const,
  networkIdentity,
  kind: 'TOKEN' as const,
  mint,
  tokenProgram: SPL_TOKEN_PROGRAM_ID,
});
const native = { chain: 'SOLANA' as const, networkIdentity: NETWORK, kind: 'NATIVE_SOL' as const };
const policy = (assetId: ReturnType<typeof token> | typeof native, version: string, slot: string) =>
  ({
    assetId,
    registryVersion: version,
    verifiedDecimals: assetId.kind === 'NATIVE_SOL' ? 9 : 6,
    observedAuthorities: [],
    supportedExtensionProfile: 'plain',
    observedAt: '2026-10-09T00:00:00Z',
    observedSlot: slot,
  }) as unknown as AssetRegistryInput['policies'][number];

// Source one: a static host object. Source two: a JSON document, as a database or file would supply.
const staticSource: AssetRegistryInput = {
  networks: [
    { networkIdentity: NETWORK, cluster: 'SYNTHETIC' },
    { networkIdentity: OTHER_NETWORK, cluster: 'SYNTHETIC' },
  ],
  assets: [
    { assetId: token(fill(1)), display: { symbol: 'USDC' }, origin: 'TEST_FIXTURE' },
    { assetId: token(fill(2)), display: { symbol: 'USDC' }, origin: 'TEST_FIXTURE' },
    { assetId: native, display: { symbol: 'SOL' }, origin: 'TEST_FIXTURE' },
  ],
  profiles: [{ id: 'plain', extensions: [] }],
  policies: [
    policy(token(fill(1)), 'v1', '100'),
    policy(token(fill(2)), 'v1', '100'),
    policy(native, 'v1', '100'),
  ],
};
const jsonSource = JSON.parse(JSON.stringify(staticSource)) as AssetRegistryInput;
const registry = createAssetRegistry(staticSource);
const alternate = createAssetRegistry(jsonSource);

// 1. Two mints with one ticker are two assets; the same mint elsewhere is rejected.
const [one, two] = [registry.resolve(token(fill(1))), registry.resolve(token(fill(2)))];
const sameTickerSeparate =
  one.display.symbol === two.display.symbol && assetKey(one.assetId) !== assetKey(two.assetId);
let wrongNetworkRejected = false;
try {
  registry.resolve(token(fill(1), OTHER_NETWORK));
} catch (error) {
  wrongNetworkRejected = error instanceof AssetRegistryError && error.code === 'UNSUPPORTED_ASSET';
}

// 2. A new policy version keeps one identity; a decimals change is refused.
const next = registry.withPolicy(policy(token(fill(1)), 'v2', '200'));
const policyVersionNoSplit =
  next.assets().length === registry.assets().length &&
  next.policies(token(fill(1))).length === 2 &&
  next.policy(token(fill(1))).registryVersion === 'v2';
let decimalsChangeRefused = false;
try {
  registry.withPolicy({ ...policy(token(fill(1)), 'v3', '300'), verifiedDecimals: 9 } as never);
} catch (error) {
  decimalsChangeRefused =
    error instanceof AssetRegistryError && error.code === 'ASSET_POLICY_CHANGED';
}

// 3. A two-asset reward is funded only when both legs are verified.
const legs = [
  { assetId: token(fill(1)), amount: toJsonAmount(parseAmount('300', 6)) },
  { assetId: native, amount: toJsonAmount(parseAmount('1.5', 9)) },
];
const partial = evaluateRewardFunding(registry, legs, [
  { operationId: 'op-1', assetId: token(fill(1)), amount: '300000000', verified: true },
  { operationId: 'op-2', assetId: token(fill(2)), amount: '999999999999', verified: true },
]);
const complete = evaluateRewardFunding(registry, legs, [
  { operationId: 'op-1', assetId: token(fill(1)), amount: '300000000', verified: true },
  { operationId: 'op-1', assetId: token(fill(1)), amount: '300000000', verified: true },
  { operationId: 'op-3', assetId: native, amount: '1500000000', verified: true },
]);

// 4. Exact amounts: no rounding, disclosed remainder rule, JSON strings only.
let excessPrecisionRefused = false;
try {
  parseAmount('0.0000001', 6);
} catch (error) {
  excessPrecisionRefused = error instanceof AssetRegistryError && error.code === 'EXCESS_PRECISION';
}
const split = splitProportional(1000n, [50n, 30n, 20n]);
const exactAmounts =
  formatAmount(250_500_000n, 6) === '250.5' &&
  fromJsonAmount('18446744073709551615') === 2n ** 64n - 1n &&
  split.shares.join(',') === '500,300,200' &&
  split.residual === 0n;

// 5. Production is blocked: no supported asset is chosen (O07), and test assets never qualify.
let productionBlocked = false;
try {
  createProductionAssetRegistry({
    ...staticSource,
    networks: [{ networkIdentity: NETWORK, cluster: 'MAINNET' }],
    providers: [{ id: 'rpc', mode: 'LIVE' }],
    programs: [{ address: SPL_TOKEN_PROGRAM_ID, origin: 'CHAIN_VERIFIED' }],
  });
} catch (error) {
  productionBlocked = error instanceof AssetRegistryError && error.code === 'PRODUCTION_BLOCKED';
}

// 6. A different source yields identical decisions.
const alternateSourceEquivalent =
  JSON.stringify(registry.assets()) === JSON.stringify(alternate.assets()) &&
  JSON.stringify(registry.evaluateSupport(native)) ===
    JSON.stringify(alternate.evaluateSupport(native));

// 7. Failures carry a code, never input text.
let sanitizedFailure = false;
try {
  parseAmount('secret-looking-text', 6);
} catch (error) {
  sanitizedFailure = error instanceof AssetRegistryError && error.message === 'INVALID_AMOUNT';
}

const result = {
  version: 'v1',
  synthetic: true,
  sameTickerSeparate,
  wrongNetworkRejected,
  policyVersionNoSplit,
  decimalsChangeRefused,
  partialRewardNotFunded: partial.fullyFunded === false,
  completeRewardFunded: complete.fullyFunded === true,
  excessPrecisionRefused,
  exactAmounts,
  emptyProductionAllowlist: PRODUCTION_ASSET_ALLOWLIST.length === 0,
  productionBlocked,
  alternateSourceEquivalent,
  sanitizedFailure,
};
assert.ok(Object.values(result).every((value) => value === true || typeof value === 'string'));
console.log(JSON.stringify(result));
