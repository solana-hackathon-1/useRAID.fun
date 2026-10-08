import bs58 from 'bs58';
import type { AssetPolicySnapshot } from '../../src/contracts';
import type { AssetRegistryInput } from '../../src/asset-registry';
import {
  AssetRegistryError,
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '../../src/asset-registry';

// Synthetic, test-only addresses. Deterministic 32-byte fills are valid base58 keys but are not real mints.
export const fixtureAddress = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill));
export const NETWORK_A = 'synthetic-network-a';
export const NETWORK_B = 'synthetic-network-b';
export const MINT_ONE = fixtureAddress(1);
export const MINT_TWO = fixtureAddress(2);
export const MINT_THREE = fixtureAddress(3);
export const UNKNOWN_PROGRAM = fixtureAddress(9);

export const token = (
  mint: string,
  networkIdentity = NETWORK_A,
  tokenProgram: string = SPL_TOKEN_PROGRAM_ID,
) => ({ chain: 'SOLANA' as const, networkIdentity, kind: 'TOKEN' as const, mint, tokenProgram });
export const native = (networkIdentity = NETWORK_A) => ({
  chain: 'SOLANA' as const,
  networkIdentity,
  kind: 'NATIVE_SOL' as const,
});

export const policy = (
  assetId: ReturnType<typeof token> | ReturnType<typeof native>,
  registryVersion = 'fixture-v1',
  overrides: Partial<{
    verifiedDecimals: number;
    supportedExtensionProfile: string;
    observedSlot: string;
  }> = {},
): AssetPolicySnapshot =>
  ({
    assetId,
    registryVersion,
    verifiedDecimals: overrides.verifiedDecimals ?? 6,
    observedAuthorities: [],
    supportedExtensionProfile: overrides.supportedExtensionProfile ?? 'plain-spl',
    observedAt: '2026-10-09T00:00:00Z',
    observedSlot: overrides.observedSlot ?? '100',
  }) as unknown as AssetPolicySnapshot;

export const PROFILES = [
  { id: 'plain-spl', extensions: [] as string[] },
  { id: 'fee-bearing', extensions: ['TransferFeeConfig'] },
  { id: 'hooked', extensions: ['TransferHook'] },
  { id: 'metadata-only', extensions: ['MetadataPointer'] },
];

export function baseInput(): AssetRegistryInput {
  const usdLikeOne = token(MINT_ONE);
  const usdLikeTwo = token(MINT_TWO);
  return {
    networks: [
      { networkIdentity: NETWORK_A, cluster: 'SYNTHETIC' as const },
      { networkIdentity: NETWORK_B, cluster: 'SYNTHETIC' as const },
    ],
    assets: [
      {
        assetId: usdLikeOne,
        display: { symbol: 'USDC' },
        origin: 'TEST_FIXTURE' as const,
      },
      {
        assetId: usdLikeTwo,
        display: { symbol: 'USDC' },
        origin: 'TEST_FIXTURE' as const,
      },
      { assetId: native(), display: { symbol: 'SOL' }, origin: 'TEST_FIXTURE' as const },
    ],
    profiles: PROFILES,
    policies: [
      policy(usdLikeOne),
      policy(usdLikeTwo),
      policy(native(), 'fixture-v1', { verifiedDecimals: 9 }),
    ],
  };
}

export { SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID };

/** Seeded PRNG so property tests are reproducible. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function randomBigint(random: () => number, maxExclusive: bigint): bigint {
  // Compose 32-bit chunks; bias is irrelevant for property coverage.
  let value = 0n;
  const chunks = Math.ceil(maxExclusive.toString(2).length / 32) + 1;
  for (let i = 0; i < chunks; i++)
    value = (value << 32n) | BigInt(Math.floor(random() * 4294967296));
  return value % maxExclusive;
}

/** The typed error code a call throws, or NO_ERROR. Non-registry errors propagate. */
export function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof AssetRegistryError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
}
