import { assetKey } from '../contracts/assets';
import { AssetRegistryError, type ProductionViolation } from './errors';
import {
  createAssetRegistry,
  type AssetIdInput,
  type AssetOrigin,
  type AssetRegistry,
  type AssetRegistryInput,
} from './registry';

/**
 * Fail-closed production validation (blueprint 16.5, I12, AC41). Open decision O07 has not chosen a
 * supported asset, so `PRODUCTION_ASSET_ALLOWLIST` is empty and every production configuration is
 * blocked by default. A host that eventually supplies an allow list must source it from a recorded
 * decision and gate G04 evidence; this module records the decision reference but cannot authenticate
 * it. Violations contain codes and positional subjects only, never input text.
 */
export interface ProviderDeclaration {
  id: string;
  mode: 'LIVE' | 'MOCK' | 'SIMULATED';
}
export interface ProgramDeclaration {
  address: string;
  origin: AssetOrigin;
}
export interface ProductionConfig extends AssetRegistryInput {
  providers: ProviderDeclaration[];
  programs: ProgramDeclaration[];
}
export interface AllowlistEntry {
  assetId: AssetIdInput;
  /** Recorded owner decision (for example the O07 resolution) that supports this asset. */
  decisionRef: string;
}
export interface ProductionValidation {
  readonly ok: boolean;
  readonly violations: readonly ProductionViolation[];
}

export const PRODUCTION_ASSET_ALLOWLIST: readonly AllowlistEntry[] = Object.freeze([]);

export function validateProductionConfig(
  config: ProductionConfig,
  allowlist: readonly AllowlistEntry[] = PRODUCTION_ASSET_ALLOWLIST,
): ProductionValidation {
  const violations: ProductionViolation[] = [];
  const add = (code: string, subject: string) => {
    if (!violations.some((entry) => entry.code === code && entry.subject === subject))
      violations.push(Object.freeze({ code, subject }));
  };
  try {
    if (!config || typeof config !== 'object')
      throw new AssetRegistryError('INVALID_CONFIGURATION');
    const keyOf = (value: unknown) => assetKey(value as AssetIdInput);
    const listed = new Map<string, string>();
    for (const entry of allowlist) listed.set(keyOf(entry.assetId), entry.decisionRef);
    const networks = Array.isArray(config.networks) ? config.networks : [];
    networks.forEach((network, index) => {
      if (network?.cluster !== 'MAINNET') add('NETWORK_NOT_MAINNET', `networks[${index}]`);
    });
    const assets = Array.isArray(config.assets) ? config.assets : [];
    if (assets.length === 0) add('NO_SUPPORTED_PRODUCTION_ASSET', 'assets');
    const programs = Array.isArray(config.programs) ? config.programs : [];
    const verifiedPrograms = new Set(
      programs.filter((p) => p?.origin === 'CHAIN_VERIFIED').map((p) => p.address),
    );
    programs.forEach((program, index) => {
      if (program?.origin !== 'CHAIN_VERIFIED')
        add('PROGRAM_NOT_CHAIN_VERIFIED', `programs[${index}]`);
    });
    assets.forEach((asset, index) => {
      const subject = `assets[${index}]`;
      let key: string;
      try {
        key = keyOf(asset?.assetId);
      } catch {
        add('INVALID_CONFIGURATION', subject);
        return;
      }
      if (asset.origin !== 'CHAIN_VERIFIED') add('ASSET_NOT_CHAIN_VERIFIED', subject);
      const reference = listed.get(key);
      if (reference === undefined) add('ASSET_NOT_ALLOWLISTED', subject);
      else if (!asset.approval || asset.approval.decisionRef !== reference)
        add('ASSET_NOT_APPROVED', subject);
      const id = asset.assetId as { kind?: string; tokenProgram?: string };
      if (id.kind === 'TOKEN' && !verifiedPrograms.has(id.tokenProgram as string))
        add('PROGRAM_NOT_CHAIN_VERIFIED', subject);
    });
    const providers = Array.isArray(config.providers) ? config.providers : [];
    if (providers.length === 0) add('PROVIDER_NOT_LIVE', 'providers');
    providers.forEach((provider, index) => {
      if (provider?.mode !== 'LIVE') add('PROVIDER_NOT_LIVE', `providers[${index}]`);
    });
    let registry: AssetRegistry | undefined;
    try {
      registry = createAssetRegistry(config);
    } catch {
      add('INVALID_CONFIGURATION', 'registry');
    }
    if (registry)
      registry.assets().forEach((asset, index) => {
        if (!registry.evaluateSupport(asset.assetId).supported)
          add('ASSET_POLICY_UNSUPPORTED', `assets[${index}]`);
      });
  } catch {
    add('INVALID_CONFIGURATION', 'config');
  }
  return Object.freeze({ ok: violations.length === 0, violations: Object.freeze(violations) });
}

export function createProductionAssetRegistry(
  config: ProductionConfig,
  allowlist: readonly AllowlistEntry[] = PRODUCTION_ASSET_ALLOWLIST,
): AssetRegistry {
  const result = validateProductionConfig(config, allowlist);
  if (!result.ok) {
    const error = new AssetRegistryError('PRODUCTION_BLOCKED');
    error.violations = result.violations;
    throw error;
  }
  return createAssetRegistry(config);
}
