import { describe, expect, it } from 'vitest';
import {
  AssetRegistryError,
  PRODUCTION_ASSET_ALLOWLIST,
  type ProductionConfig,
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createProductionAssetRegistry,
  validateProductionConfig,
} from '../src/asset-registry';
import {
  MINT_ONE,
  MINT_THREE,
  NETWORK_A,
  PROFILES,
  fixtureAddress,
  policy,
  token,
  codeOf,
} from './helpers/asset-fixtures';

// A hypothetical future configuration that satisfies every rule. The addresses are generated test
// bytes and the allow list below exists only inside this test; nothing here is a supported asset.
const MAINNET_LIKE = 'hostdeclared-mainnet-network';
const real = token(MINT_ONE, MAINNET_LIKE);
function candidate(): ProductionConfig {
  return {
    networks: [{ networkIdentity: MAINNET_LIKE, cluster: 'MAINNET' as const }],
    assets: [
      {
        assetId: real,
        display: { symbol: 'EXAMPLE' },
        origin: 'CHAIN_VERIFIED' as const,
        approval: { decisionRef: 'test-only-decision-reference' },
      },
    ],
    profiles: PROFILES,
    policies: [policy(real)],
    providers: [{ id: 'rpc-primary', mode: 'LIVE' as const }],
    programs: [{ address: SPL_TOKEN_PROGRAM_ID, origin: 'CHAIN_VERIFIED' as const }],
  };
}
const allowlist = [{ assetId: real, decisionRef: 'test-only-decision-reference' }];
const codes = (config: ProductionConfig, list = allowlist) =>
  validateProductionConfig(config, list).violations.map((violation) => violation.code);

describe('T029 production validation fails closed (AC41, I12, O07)', () => {
  it('ships no supported production asset until O07 supplies one', () => {
    expect(PRODUCTION_ASSET_ALLOWLIST).toEqual([]);
    expect(Object.isFrozen(PRODUCTION_ASSET_ALLOWLIST)).toBe(true);
    const result = validateProductionConfig(candidate());
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain('ASSET_NOT_ALLOWLISTED');
    expect(codeOf(() => createProductionAssetRegistry(candidate()))).toBe('PRODUCTION_BLOCKED');
  });
  it('blocks an empty configuration', () => {
    const empty = { ...candidate(), assets: [], policies: [] };
    expect(codes(empty)).toContain('NO_SUPPORTED_PRODUCTION_ASSET');
    expect(validateProductionConfig(empty, allowlist).ok).toBe(false);
  });
  it('accepts a fully verified, approved, allow-listed configuration only when the host supplies the list', () => {
    const result = validateProductionConfig(candidate(), allowlist);
    expect(result).toEqual({ ok: true, violations: [] });
    const registry = createProductionAssetRegistry(candidate(), allowlist);
    expect(registry.resolve(real).display.symbol).toBe('EXAMPLE');
  });
  it.each(['DEVNET', 'TESTNET', 'LOCAL', 'SYNTHETIC'] as const)(
    'blocks a %s network in a production profile',
    (cluster) => {
      const config = candidate();
      config.networks = [{ networkIdentity: MAINNET_LIKE, cluster }];
      expect(codes(config)).toContain('NETWORK_NOT_MAINNET');
      expect(codeOf(() => createProductionAssetRegistry(config, allowlist))).toBe(
        'PRODUCTION_BLOCKED',
      );
    },
  );
  it('blocks test fixture and sample assets even when listed', () => {
    for (const origin of ['TEST_FIXTURE', 'SAMPLE'] as const) {
      const config = candidate();
      config.assets = [{ ...config.assets[0], origin } as never];
      expect(codes(config)).toContain('ASSET_NOT_CHAIN_VERIFIED');
    }
  });
  it('blocks mock and simulated providers', () => {
    for (const mode of ['MOCK', 'SIMULATED'] as const) {
      const config = candidate();
      config.providers = [{ id: 'fake-rpc', mode }];
      expect(codes(config)).toContain('PROVIDER_NOT_LIVE');
    }
    const none = candidate();
    none.providers = [];
    expect(codes(none)).toContain('PROVIDER_NOT_LIVE');
  });
  it('blocks test or sample program identifiers', () => {
    for (const origin of ['TEST_FIXTURE', 'SAMPLE'] as const) {
      const config = candidate();
      config.programs = [{ address: fixtureAddress(7), origin }];
      expect(codes(config)).toContain('PROGRAM_NOT_CHAIN_VERIFIED');
    }
  });
  it('blocks an asset without a recorded decision reference matching the allow list entry', () => {
    const noApproval = candidate();
    noApproval.assets = [{ ...noApproval.assets[0], approval: undefined } as never];
    expect(codes(noApproval)).toContain('ASSET_NOT_APPROVED');
    const wrongRef = candidate();
    expect(codes(wrongRef, [{ assetId: real, decisionRef: 'another-decision' }])).toContain(
      'ASSET_NOT_APPROVED',
    );
  });
  it('blocks an asset that is allow-listed on a different network or mint', () => {
    expect(
      codes(candidate(), [{ assetId: token(MINT_THREE, MAINNET_LIKE), decisionRef: 'x' }]),
    ).toContain('ASSET_NOT_ALLOWLISTED');
    expect(
      codes(candidate(), [{ assetId: token(MINT_ONE, NETWORK_A), decisionRef: 'x' }]),
    ).toContain('ASSET_NOT_ALLOWLISTED');
  });
  it('blocks an asset whose policy is unsupported (rejected extension, unknown program, no policy)', () => {
    const fee = candidate();
    const id = token(MINT_ONE, MAINNET_LIKE, TOKEN_2022_PROGRAM_ID);
    fee.assets = [{ ...fee.assets[0], assetId: id } as never];
    fee.policies = [policy(id, 'fixture-v1', { supportedExtensionProfile: 'fee-bearing' })];
    expect(codes(fee, [{ assetId: id, decisionRef: 'test-only-decision-reference' }])).toContain(
      'ASSET_POLICY_UNSUPPORTED',
    );
    const noPolicy = candidate();
    noPolicy.policies = [];
    expect(codes(noPolicy)).toContain('ASSET_POLICY_UNSUPPORTED');
  });
  it('reports every violation at once and carries no input text', () => {
    const config = candidate();
    config.networks = [{ networkIdentity: MAINNET_LIKE, cluster: 'DEVNET' }];
    config.providers = [{ id: 'secret-endpoint-name', mode: 'MOCK' }];
    const result = validateProductionConfig(config);
    expect(result.violations.map((violation) => violation.code).sort()).toEqual(
      expect.arrayContaining(['ASSET_NOT_ALLOWLISTED', 'NETWORK_NOT_MAINNET', 'PROVIDER_NOT_LIVE']),
    );
    try {
      createProductionAssetRegistry(config);
    } catch (error) {
      expect((error as Error).message).toBe('PRODUCTION_BLOCKED');
      expect(JSON.stringify((error as AssetRegistryError).violations)).toContain(
        'PROVIDER_NOT_LIVE',
      );
      return;
    }
    throw new Error('expected production block');
  });
  it('treats malformed configuration as blocked, never as acceptable', () => {
    expect(validateProductionConfig(null as never).ok).toBe(false);
    expect(validateProductionConfig({} as never).ok).toBe(false);
    const garbage = candidate();
    garbage.assets = [{ assetId: { symbol: 'USDC' } } as never];
    expect(validateProductionConfig(garbage, allowlist).ok).toBe(false);
  });
});
