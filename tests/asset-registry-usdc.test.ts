import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  PRODUCTION_ASSET_ALLOWLIST,
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  USDC_DECISION_REF,
  USDC_DEVNET_ASSET_ID,
  USDC_DEVNET_REGISTRY_ENTRY,
  USDC_MAINNET_ASSET_ID,
  USDC_MAINNET_MINT,
  USDC_DEVNET_MINT,
  SOLANA_MAINNET_GENESIS,
  SOLANA_DEVNET_GENESIS,
  createAssetRegistry,
  createProductionAssetRegistry,
  validateProductionConfig,
  type ProductionConfig,
} from '../src/asset-registry';
import { assetKey } from '../src/contracts/assets';
import { PROFILES, codeOf, fixtureAddress, policy, token } from './helpers/asset-fixtures';

// DEC-2026-11-07-03 (O07): canonical USDC on Solana is the only first-release Raid funding asset.
const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
const FREEZE_AUTHORITY = fixtureAddress(42);

function config(
  assetId: Parameters<typeof policy>[0],
  overrides: Partial<ProductionConfig> = {},
  approval: { decisionRef: string } | null = { decisionRef: USDC_DECISION_REF },
): ProductionConfig {
  return {
    networks: [{ networkIdentity: SOLANA_MAINNET_GENESIS, cluster: 'MAINNET' }],
    assets: [
      {
        assetId,
        display: { symbol: 'USDC' },
        origin: 'CHAIN_VERIFIED',
        approval: approval ?? undefined,
      },
    ] as never,
    profiles: PROFILES,
    policies: [policy(assetId)],
    providers: [{ id: 'rpc-primary', mode: 'LIVE' }],
    programs: [{ address: SPL_TOKEN_PROGRAM_ID, origin: 'CHAIN_VERIFIED' }],
    ...overrides,
  };
}
const codes = (c: ProductionConfig) => validateProductionConfig(c).violations.map((v) => v.code);

describe('DEC-2026-11-07-03 canonical USDC production allow list', () => {
  it('lists exactly canonical mainnet USDC with the recorded decision reference', () => {
    expect(Object.isFrozen(PRODUCTION_ASSET_ALLOWLIST)).toBe(true);
    expect(PRODUCTION_ASSET_ALLOWLIST).toHaveLength(1);
    const [entry] = PRODUCTION_ASSET_ALLOWLIST;
    expect(entry.decisionRef).toBe('DEC-2026-11-07-03');
    expect(assetKey(entry.assetId)).toBe(assetKey(USDC_MAINNET_ASSET_ID));
    expect(USDC_MAINNET_ASSET_ID).toEqual({
      chain: 'SOLANA',
      networkIdentity: SOLANA_MAINNET_GENESIS,
      kind: 'TOKEN',
      mint: USDC_MAINNET_MINT,
      tokenProgram: SPL_TOKEN_PROGRAM_ID,
    });
  });

  it('pins the mints to the legacy USDC_MINTS without importing app code', async () => {
    const source = await readFile('src/lib/usdc.ts', 'utf8');
    const block = source.match(/export const USDC_MINTS = \{([^}]*)\}/)?.[1] ?? '';
    expect(block).toContain(`mainnet: '${USDC_MAINNET_MINT}'`);
    expect(block).toContain(`devnet: '${USDC_DEVNET_MINT}'`);
    const own = await readFile('src/asset-registry/usdc.ts', 'utf8');
    expect(own).not.toMatch(/from ['"].*lib\//);
  });

  it('accepts mainnet USDC with live provider and verified program', () => {
    expect(validateProductionConfig(config(USDC_MAINNET_ASSET_ID))).toEqual({
      ok: true,
      violations: [],
    });
    const registry = createProductionAssetRegistry(config(USDC_MAINNET_ASSET_ID));
    expect(registry.has(USDC_MAINNET_ASSET_ID)).toBe(true);
  });

  it('does not reject USDC because a freeze authority is present', () => {
    const withFreeze = config(USDC_MAINNET_ASSET_ID, {
      policies: [
        { ...policy(USDC_MAINNET_ASSET_ID), observedAuthorities: [FREEZE_AUTHORITY] } as never,
      ],
    });
    expect(validateProductionConfig(withFreeze).ok).toBe(true);
    const registry = createAssetRegistry(withFreeze);
    expect(registry.evaluateSupport(USDC_MAINNET_ASSET_ID).supported).toBe(true);
  });

  it('requires the matching decision reference', () => {
    expect(codes(config(USDC_MAINNET_ASSET_ID, {}, null))).toContain('ASSET_NOT_APPROVED');
    expect(codes(config(USDC_MAINNET_ASSET_ID, {}, { decisionRef: 'other' }))).toContain(
      'ASSET_NOT_APPROVED',
    );
  });

  it('rejects an arbitrary SPL token for Raid funding', () => {
    const arbitrary = token(fixtureAddress(7), SOLANA_MAINNET_GENESIS);
    expect(codes(config(arbitrary))).toContain('ASSET_NOT_ALLOWLISTED');
    expect(codeOf(() => createProductionAssetRegistry(config(arbitrary)))).toBe(
      'PRODUCTION_BLOCKED',
    );
  });

  it('rejects a Guild token (any non-USDC mint, even one using the USDC ticker)', () => {
    const guild = token(fixtureAddress(8), SOLANA_MAINNET_GENESIS);
    expect(codes(config(guild))).toContain('ASSET_NOT_ALLOWLISTED');
  });

  it('rejects wrapped SOL and native SOL', () => {
    const wrapped = token(WRAPPED_SOL_MINT, SOLANA_MAINNET_GENESIS);
    expect(codes(config(wrapped))).toContain('ASSET_NOT_ALLOWLISTED');
    const native = { chain: 'SOLANA', networkIdentity: SOLANA_MAINNET_GENESIS, kind: 'NATIVE_SOL' };
    expect(codes(config(native as never))).toContain('ASSET_NOT_ALLOWLISTED');
  });

  it('rejects Token-2022, including the USDC mint under the Token-2022 program', () => {
    const t22 = token(USDC_MAINNET_MINT, SOLANA_MAINNET_GENESIS, TOKEN_2022_PROGRAM_ID);
    const c = config(t22, {
      programs: [{ address: TOKEN_2022_PROGRAM_ID, origin: 'CHAIN_VERIFIED' }],
    });
    expect(codes(c)).toContain('ASSET_NOT_ALLOWLISTED');
    const other = token(fixtureAddress(9), SOLANA_MAINNET_GENESIS, TOKEN_2022_PROGRAM_ID);
    expect(
      codes(
        config(other, { programs: [{ address: TOKEN_2022_PROGRAM_ID, origin: 'CHAIN_VERIFIED' }] }),
      ),
    ).toContain('ASSET_NOT_ALLOWLISTED');
  });

  it('rejects USDC on another network identity and the devnet mint in production', () => {
    const wrongNet = token(USDC_MAINNET_MINT, 'synthetic-network-a');
    expect(codes(config(wrongNet))).toContain('ASSET_NOT_ALLOWLISTED');
    const devnet = config(USDC_DEVNET_ASSET_ID, {
      networks: [{ networkIdentity: SOLANA_DEVNET_GENESIS, cluster: 'DEVNET' }],
    });
    const found = codes(devnet);
    expect(found).toContain('NETWORK_NOT_MAINNET');
    expect(found).toContain('ASSET_NOT_ALLOWLISTED');
  });

  it('keeps the devnet mint as a devnet-only registry entry', () => {
    expect(USDC_DEVNET_ASSET_ID.networkIdentity).toBe(SOLANA_DEVNET_GENESIS);
    expect(USDC_DEVNET_REGISTRY_ENTRY.origin).toBe('CHAIN_VERIFIED');
    expect(PRODUCTION_ASSET_ALLOWLIST.map((e) => assetKey(e.assetId))).not.toContain(
      assetKey(USDC_DEVNET_ASSET_ID),
    );
    const registry = createAssetRegistry({
      networks: [{ networkIdentity: SOLANA_DEVNET_GENESIS, cluster: 'DEVNET' }],
      assets: [USDC_DEVNET_REGISTRY_ENTRY],
      profiles: PROFILES,
      policies: [policy(USDC_DEVNET_ASSET_ID)],
    });
    expect(registry.evaluateSupport(USDC_DEVNET_ASSET_ID).supported).toBe(true);
    expect(registry.has(USDC_MAINNET_ASSET_ID)).toBe(false);
  });
});
