import {
  AssetIdSchema,
  AssetPolicySnapshotSchema,
  assetKey,
  type AssetId,
  type AssetPolicySnapshot,
} from '../contracts/assets';
import { InternalId } from '../contracts/ids';
import { AssetRegistryError, type AssetRegistryErrorCode } from './errors';

/**
 * Immutable exact-asset registry (blueprint 16.2, 16.5).
 *
 * Identity is chain + network identity + kind + mint + token program, exactly as `assetKey` in the
 * shared contracts computes it. Symbols, names and images are display metadata: no method selects
 * an asset by them. Policy snapshots (decimals, authorities, extension profile, observation) are
 * versioned separately and never change an asset's identity. Nothing here proves an asset exists on
 * chain; `origin` and `approval` are host assertions that the production validator refuses to trust
 * unless an allow list from a recorded decision (O07/G04) lists the asset.
 */
export const SPL_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
/** Extensions rejected by default in section 16.5; this module cannot allow them. */
export const REJECTED_TOKEN_EXTENSIONS: readonly string[] = Object.freeze([
  'TransferFeeConfig',
  'TransferHook',
  'PermanentDelegate',
  'NonTransferable',
  'ConfidentialTransferMint',
  'ConfidentialTransferFeeConfig',
  'DefaultAccountStateFrozen',
]);

export type AssetIdInput = Parameters<typeof assetKey>[0];
export type NetworkCluster = 'MAINNET' | 'DEVNET' | 'TESTNET' | 'LOCAL' | 'SYNTHETIC';
export type AssetOrigin = 'CHAIN_VERIFIED' | 'TEST_FIXTURE' | 'SAMPLE';
export interface NetworkDeclaration {
  /** Cluster/genesis identity; must equal `networkIdentity` in asset identities. */
  networkIdentity: string;
  cluster: NetworkCluster;
}
export interface AssetDisplay {
  /** Display only. Never used for lookup, equality or substitution. */
  symbol: string;
  name?: string;
}
export interface RegisteredAssetInput {
  assetId: AssetIdInput;
  display: AssetDisplay;
  origin: AssetOrigin;
  /** Recorded owner decision for support (O07); not authenticated by this module. */
  approval?: { decisionRef: string };
}
export interface RegisteredAsset {
  readonly assetId: AssetId;
  readonly display: Readonly<AssetDisplay>;
  readonly origin: AssetOrigin;
  readonly approval?: Readonly<{ decisionRef: string }>;
}
export interface ExtensionProfile {
  id: string;
  /** Observed Token-2022 extension names for assets using this profile. Empty for plain SPL/native. */
  extensions: readonly string[];
}
export interface AssetRegistryInput {
  networks: NetworkDeclaration[];
  assets: RegisteredAssetInput[];
  profiles: ExtensionProfile[];
  policies: AssetPolicySnapshot[];
  /** Reviewed Token-2022 extensions that may appear in a profile. Default: none. */
  allowedExtensions?: string[];
}
export interface SupportVerdict {
  readonly supported: boolean;
  readonly reasons: readonly string[];
}

const CLUSTERS: ReadonlySet<string> = new Set([
  'MAINNET',
  'DEVNET',
  'TESTNET',
  'LOCAL',
  'SYNTHETIC',
]);
const ORIGINS: ReadonlySet<string> = new Set(['CHAIN_VERIFIED', 'TEST_FIXTURE', 'SAMPLE']);
const KNOWN_PROGRAMS: ReadonlySet<string> = new Set([SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]);

function fail(code: AssetRegistryErrorCode): never {
  throw new AssetRegistryError(code);
}
function parseAssetId(value: unknown): AssetId {
  const parsed = AssetIdSchema.safeParse(value);
  if (!parsed.success) fail('INVALID_ASSET_ID');
  return parsed.data;
}
function parseOrConfig<T>(parse: () => T): T {
  try {
    return parse();
  } catch {
    return fail('INVALID_CONFIGURATION');
  }
}
function validText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max;
}

interface State {
  networks: ReadonlyMap<string, NetworkCluster>;
  assets: ReadonlyMap<string, RegisteredAsset>;
  profiles: ReadonlyMap<string, readonly string[]>;
  policies: ReadonlyMap<string, readonly AssetPolicySnapshot[]>;
  allowedExtensions: ReadonlySet<string>;
}

/** Returns the new policy list for a key, or the same list when the snapshot is an exact repeat. */
function recordPolicy(
  existing: readonly AssetPolicySnapshot[],
  snapshot: AssetPolicySnapshot,
): readonly AssetPolicySnapshot[] {
  const same = existing.find((entry) => entry.registryVersion === snapshot.registryVersion);
  if (same) {
    if (JSON.stringify(same) !== JSON.stringify(snapshot)) fail('ASSET_POLICY_CHANGED');
    return existing;
  }
  if (existing.some((entry) => entry.verifiedDecimals !== snapshot.verifiedDecimals))
    fail('ASSET_POLICY_CHANGED');
  const last = existing[existing.length - 1];
  if (last && BigInt(snapshot.observedSlot) < BigInt(last.observedSlot))
    fail('ASSET_POLICY_CHANGED');
  return Object.freeze([...existing, snapshot]);
}

export class AssetRegistry {
  private constructor(private readonly state: State) {}

  static create(input: AssetRegistryInput): AssetRegistry {
    if (!input || typeof input !== 'object') fail('INVALID_CONFIGURATION');
    const networks = new Map<string, NetworkCluster>();
    for (const network of input.networks ?? []) {
      parseOrConfig(() => InternalId.parse(network?.networkIdentity));
      if (!CLUSTERS.has(network.cluster) || networks.has(network.networkIdentity))
        fail('INVALID_CONFIGURATION');
      networks.set(network.networkIdentity, network.cluster);
    }
    const profiles = new Map<string, readonly string[]>();
    for (const profile of input.profiles ?? []) {
      parseOrConfig(() => InternalId.parse(profile?.id));
      if (
        profiles.has(profile.id) ||
        !Array.isArray(profile.extensions) ||
        !profile.extensions.every((name) => validText(name, 100))
      )
        fail('INVALID_CONFIGURATION');
      profiles.set(profile.id, Object.freeze([...profile.extensions]));
    }
    const allowed = input.allowedExtensions ?? [];
    if (!Array.isArray(allowed) || !allowed.every((name) => validText(name, 100)))
      fail('INVALID_CONFIGURATION');
    const assets = new Map<string, RegisteredAsset>();
    for (const entry of input.assets ?? []) {
      const assetId = parseOrConfig(() => parseAssetId(entry?.assetId));
      const key = assetKey(assetId);
      if (
        !networks.has(assetId.networkIdentity) ||
        assets.has(key) ||
        !validText(entry.display?.symbol, 32) ||
        (entry.display.name !== undefined && !validText(entry.display.name, 100)) ||
        !ORIGINS.has(entry.origin) ||
        (entry.approval !== undefined && !validText(entry.approval?.decisionRef, 200))
      )
        fail('INVALID_CONFIGURATION');
      assets.set(
        key,
        Object.freeze({
          assetId,
          display: Object.freeze({ symbol: entry.display.symbol, name: entry.display.name }),
          origin: entry.origin,
          approval: entry.approval
            ? Object.freeze({ decisionRef: entry.approval.decisionRef })
            : undefined,
        }),
      );
    }
    const policies = new Map<string, readonly AssetPolicySnapshot[]>();
    for (const raw of input.policies ?? []) {
      const snapshot = parseOrConfig(() => AssetPolicySnapshotSchema.parse(raw));
      const key = assetKey(snapshot.assetId);
      if (!assets.has(key)) fail('INVALID_CONFIGURATION');
      policies.set(key, recordPolicy(policies.get(key) ?? [], snapshot));
    }
    return new AssetRegistry({
      networks,
      assets,
      profiles,
      policies,
      allowedExtensions: new Set(allowed),
    });
  }

  /** Canonical identity key; throws `INVALID_ASSET_ID` for anything but an exact asset identity. */
  keyOf(assetId: AssetIdInput): string {
    return assetKey(parseAssetId(assetId));
  }

  has(assetId: AssetIdInput): boolean {
    try {
      this.resolve(assetId);
      return true;
    } catch (error) {
      if (error instanceof AssetRegistryError) return false;
      throw error;
    }
  }

  resolve(assetId: AssetIdInput): RegisteredAsset {
    const found = this.state.assets.get(this.keyOf(assetId));
    if (!found) fail('UNSUPPORTED_ASSET');
    return found;
  }

  /** Fails with `ASSET_MISMATCH` unless both identities are exactly the same instrument. */
  requireSame(a: AssetIdInput, b: AssetIdInput): void {
    if (this.keyOf(a) !== this.keyOf(b)) fail('ASSET_MISMATCH');
  }

  assets(): readonly RegisteredAsset[] {
    return Object.freeze([...this.state.assets.values()]);
  }

  policies(assetId: AssetIdInput): readonly AssetPolicySnapshot[] {
    const asset = this.resolve(assetId);
    return this.state.policies.get(assetKey(asset.assetId)) ?? Object.freeze([]);
  }

  /** The newest snapshot, or the exact pinned `registryVersion` (never a guess). */
  policy(assetId: AssetIdInput, registryVersion?: string): AssetPolicySnapshot {
    const list = this.policies(assetId);
    const found =
      registryVersion === undefined
        ? list[list.length - 1]
        : list.find((entry) => entry.registryVersion === registryVersion);
    if (!found) fail('UNSUPPORTED_ASSET');
    return found;
  }

  /**
   * Returns a new registry that also holds `snapshot`. Same version and content is idempotent. A
   * different snapshot under a recorded version, a changed decimals value or an observation older
   * than the latest recorded one is `ASSET_POLICY_CHANGED`: accepted amounts must keep their meaning.
   */
  withPolicy(snapshot: AssetPolicySnapshot): AssetRegistry {
    const parsed = parseOrConfig(() => AssetPolicySnapshotSchema.parse(snapshot));
    const key = assetKey(parsed.assetId);
    if (!this.state.assets.has(key)) fail('UNSUPPORTED_ASSET');
    const policies = new Map(this.state.policies);
    policies.set(key, recordPolicy(policies.get(key) ?? [], parsed));
    return new AssetRegistry({ ...this.state, policies });
  }

  /** Fail-closed support verdict from the latest policy; every unmet rule is listed. */
  evaluateSupport(assetId: AssetIdInput): SupportVerdict {
    const asset = this.resolve(assetId);
    const list = this.state.policies.get(assetKey(asset.assetId)) ?? [];
    const snapshot = list[list.length - 1];
    if (!snapshot)
      return Object.freeze({ supported: false, reasons: Object.freeze(['NO_POLICY']) });
    const reasons: string[] = [];
    const id = asset.assetId;
    const legacy = id.kind === 'TOKEN' && id.tokenProgram === SPL_TOKEN_PROGRAM_ID;
    const modern = id.kind === 'TOKEN' && id.tokenProgram === TOKEN_2022_PROGRAM_ID;
    if (id.kind === 'TOKEN' && !KNOWN_PROGRAMS.has(id.tokenProgram))
      reasons.push('UNKNOWN_TOKEN_PROGRAM');
    const extensions = this.state.profiles.get(snapshot.supportedExtensionProfile);
    if (!extensions) reasons.push('UNKNOWN_EXTENSION_PROFILE');
    else {
      for (const extension of extensions) {
        if (REJECTED_TOKEN_EXTENSIONS.includes(extension))
          reasons.push(`REJECTED_EXTENSION:${extension}`);
        else if (modern && !this.state.allowedExtensions.has(extension))
          reasons.push(`UNREVIEWED_EXTENSION:${extension}`);
      }
      if (legacy && extensions.length > 0) reasons.push('EXTENSIONS_ON_LEGACY_PROGRAM');
      if (id.kind === 'NATIVE_SOL' && extensions.length > 0)
        reasons.push('EXTENSIONS_ON_NATIVE_ASSET');
    }
    return Object.freeze({ supported: reasons.length === 0, reasons: Object.freeze(reasons) });
  }
}

export function createAssetRegistry(input: AssetRegistryInput): AssetRegistry {
  return AssetRegistry.create(input);
}
