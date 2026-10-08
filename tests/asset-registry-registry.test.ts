import { describe, expect, it } from 'vitest';
import { assetKey } from '../src/contracts';
import {
  AssetRegistryError,
  REJECTED_TOKEN_EXTENSIONS,
  createAssetRegistry,
} from '../src/asset-registry';
import {
  MINT_ONE,
  MINT_THREE,
  MINT_TWO,
  NETWORK_A,
  NETWORK_B,
  PROFILES,
  TOKEN_2022_PROGRAM_ID,
  UNKNOWN_PROGRAM,
  baseInput,
  native,
  policy,
  token,
  codeOf,
} from './helpers/asset-fixtures';

describe('T029 asset identity is exact and never display-based (AC29, 16.2)', () => {
  it('treats two mints that share a ticker as two distinct assets', () => {
    const registry = createAssetRegistry(baseInput());
    const one = registry.resolve(token(MINT_ONE));
    const two = registry.resolve(token(MINT_TWO));
    expect(one.display.symbol).toBe('USDC');
    expect(two.display.symbol).toBe('USDC');
    expect(assetKey(one.assetId)).not.toBe(assetKey(two.assetId));
    expect(() => registry.requireSame(token(MINT_ONE), token(MINT_TWO))).toThrowError(
      new AssetRegistryError('ASSET_MISMATCH'),
    );
    expect(() => registry.requireSame(token(MINT_ONE), token(MINT_ONE))).not.toThrow();
  });
  it('rejects the same mint presented on another network', () => {
    const registry = createAssetRegistry(baseInput());
    expect(codeOf(() => registry.resolve(token(MINT_ONE, NETWORK_B)))).toBe('UNSUPPORTED_ASSET');
    expect(registry.has(token(MINT_ONE, NETWORK_B))).toBe(false);
    expect(codeOf(() => registry.requireSame(token(MINT_ONE), token(MINT_ONE, NETWORK_B)))).toBe(
      'ASSET_MISMATCH',
    );
  });
  it('rejects the same mint under another token program', () => {
    const registry = createAssetRegistry(baseInput());
    expect(codeOf(() => registry.resolve(token(MINT_ONE, NETWORK_A, TOKEN_2022_PROGRAM_ID)))).toBe(
      'UNSUPPORTED_ASSET',
    );
  });
  it('distinguishes native SOL from a token and one network from another', () => {
    const registry = createAssetRegistry(baseInput());
    expect(registry.resolve(native()).assetId.kind).toBe('NATIVE_SOL');
    expect(codeOf(() => registry.resolve(native(NETWORK_B)))).toBe('UNSUPPORTED_ASSET');
  });
  it('cannot select an asset by ticker, name or smuggled display fields', () => {
    const registry = createAssetRegistry(baseInput());
    expect(codeOf(() => registry.resolve({ symbol: 'USDC' } as never))).toBe('INVALID_ASSET_ID');
    expect(codeOf(() => registry.resolve({ ...token(MINT_ONE), symbol: 'USDC' } as never))).toBe(
      'INVALID_ASSET_ID',
    );
    expect(codeOf(() => registry.resolve('USDC' as never))).toBe('INVALID_ASSET_ID');
    expect(codeOf(() => registry.resolve(null as never))).toBe('INVALID_ASSET_ID');
    expect(registry.has({ symbol: 'USDC' } as never)).toBe(false);
  });
  it('is immutable to later mutation of its inputs and outputs', () => {
    const input = baseInput();
    const registry = createAssetRegistry(input);
    input.assets.length = 0;
    input.assets.push({
      assetId: token(MINT_THREE),
      display: { symbol: 'X' },
      origin: 'TEST_FIXTURE',
    });
    expect(registry.has(token(MINT_THREE))).toBe(false);
    expect(registry.has(token(MINT_ONE))).toBe(true);
    const listed = registry.assets();
    expect(Object.isFrozen(listed)).toBe(true);
    expect(Object.isFrozen(listed[0])).toBe(true);
  });
  it('rejects ambiguous or inconsistent registry configuration', () => {
    const duplicate = baseInput();
    duplicate.assets.push({ ...duplicate.assets[0], display: { symbol: 'OTHER' } });
    expect(codeOf(() => createAssetRegistry(duplicate))).toBe('INVALID_CONFIGURATION');
    const unknownNetwork = baseInput();
    unknownNetwork.assets.push({
      assetId: token(MINT_THREE, 'undeclared-network'),
      display: { symbol: 'Z' },
      origin: 'TEST_FIXTURE',
    });
    expect(codeOf(() => createAssetRegistry(unknownNetwork))).toBe('INVALID_CONFIGURATION');
    const dupNetwork = baseInput();
    dupNetwork.networks.push({ networkIdentity: NETWORK_A, cluster: 'DEVNET' });
    expect(codeOf(() => createAssetRegistry(dupNetwork))).toBe('INVALID_CONFIGURATION');
    const orphanPolicy = baseInput();
    orphanPolicy.policies.push(policy(token(MINT_THREE)));
    expect(codeOf(() => createAssetRegistry(orphanPolicy))).toBe('INVALID_CONFIGURATION');
    const dupProfile = baseInput();
    dupProfile.profiles = [...PROFILES, PROFILES[0]];
    expect(codeOf(() => createAssetRegistry(dupProfile))).toBe('INVALID_CONFIGURATION');
  });
});

describe('T029 policy versions never create or split an asset (AC30, 16.2)', () => {
  it('keeps one identity and key across registry versions and returns the newest policy', () => {
    const base = createAssetRegistry(baseInput());
    const next = base.withPolicy(policy(token(MINT_ONE), 'fixture-v2', { observedSlot: '200' }));
    expect(next.assets()).toHaveLength(base.assets().length);
    expect(next.policies(token(MINT_ONE)).map((p) => p.registryVersion)).toEqual([
      'fixture-v1',
      'fixture-v2',
    ]);
    expect(next.policy(token(MINT_ONE)).registryVersion).toBe('fixture-v2');
    expect(next.policy(token(MINT_ONE), 'fixture-v1').registryVersion).toBe('fixture-v1');
    expect(base.policies(token(MINT_ONE))).toHaveLength(1);
    expect(assetKey(next.policy(token(MINT_ONE)).assetId)).toBe(assetKey(token(MINT_ONE)));
  });
  it('treats re-recording an identical snapshot as idempotent', () => {
    const base = createAssetRegistry(baseInput());
    const again = base.withPolicy(policy(token(MINT_ONE), 'fixture-v1'));
    expect(again.policies(token(MINT_ONE))).toHaveLength(1);
  });
  it('rejects a different snapshot under an existing version', () => {
    const base = createAssetRegistry(baseInput());
    const changed = policy(token(MINT_ONE), 'fixture-v1', { observedSlot: '999' });
    expect(codeOf(() => base.withPolicy(changed))).toBe('ASSET_POLICY_CHANGED');
  });
  it('rejects a decimals change for the same asset so accepted amounts keep their meaning', () => {
    const base = createAssetRegistry(baseInput());
    const reinterpret = policy(token(MINT_ONE), 'fixture-v2', { verifiedDecimals: 9 });
    expect(codeOf(() => base.withPolicy(reinterpret))).toBe('ASSET_POLICY_CHANGED');
  });
  it('rejects a snapshot for an unregistered asset instead of registering it implicitly', () => {
    const base = createAssetRegistry(baseInput());
    expect(codeOf(() => base.withPolicy(policy(token(MINT_THREE))))).toBe('UNSUPPORTED_ASSET');
  });
  it('rejects a snapshot whose observed slot moves backwards', () => {
    const base = createAssetRegistry(baseInput());
    const older = policy(token(MINT_ONE), 'fixture-v2', { observedSlot: '99' });
    expect(codeOf(() => base.withPolicy(older))).toBe('ASSET_POLICY_CHANGED');
  });
  it('errors when a pinned policy version is unknown and does not guess', () => {
    const registry = createAssetRegistry(baseInput());
    expect(codeOf(() => registry.policy(token(MINT_ONE), 'never-recorded'))).toBe(
      'UNSUPPORTED_ASSET',
    );
  });
});

describe('T029 support policy is fail-closed (16.5)', () => {
  it('supports a plain SPL token with no extensions and native SOL', () => {
    const registry = createAssetRegistry(baseInput());
    expect(registry.evaluateSupport(token(MINT_ONE))).toEqual({ supported: true, reasons: [] });
    expect(registry.evaluateSupport(native()).supported).toBe(true);
  });
  it('lists the sixteen-point-five extensions as always rejected', () => {
    expect([...REJECTED_TOKEN_EXTENSIONS].sort()).toEqual(
      [
        'ConfidentialTransferFeeConfig',
        'ConfidentialTransferMint',
        'DefaultAccountStateFrozen',
        'NonTransferable',
        'PermanentDelegate',
        'TransferFeeConfig',
        'TransferHook',
      ].sort(),
    );
  });
  it('rejects transfer-fee and transfer-hook profiles by default', () => {
    const input = baseInput();
    input.assets.push({
      assetId: token(MINT_THREE, NETWORK_A, TOKEN_2022_PROGRAM_ID),
      display: { symbol: 'FEE' },
      origin: 'TEST_FIXTURE',
    });
    input.policies.push(
      policy(token(MINT_THREE, NETWORK_A, TOKEN_2022_PROGRAM_ID), 'fixture-v1', {
        supportedExtensionProfile: 'fee-bearing',
      }),
    );
    const registry = createAssetRegistry(input);
    const verdict = registry.evaluateSupport(token(MINT_THREE, NETWORK_A, TOKEN_2022_PROGRAM_ID));
    expect(verdict.supported).toBe(false);
    expect(verdict.reasons).toContain('REJECTED_EXTENSION:TransferFeeConfig');
  });
  it('rejects a Token-2022 asset whose extension is not on the reviewed allow list', () => {
    const input = baseInput();
    const id = token(MINT_THREE, NETWORK_A, TOKEN_2022_PROGRAM_ID);
    input.assets.push({ assetId: id, display: { symbol: 'META' }, origin: 'TEST_FIXTURE' });
    input.policies.push(policy(id, 'fixture-v1', { supportedExtensionProfile: 'metadata-only' }));
    const closed = createAssetRegistry(input);
    expect(closed.evaluateSupport(id).reasons).toContain('UNREVIEWED_EXTENSION:MetadataPointer');
    const open = createAssetRegistry({ ...input, allowedExtensions: ['MetadataPointer'] });
    expect(open.evaluateSupport(id)).toEqual({ supported: true, reasons: [] });
  });
  it('never lets the allow list override the rejected extensions', () => {
    const input = baseInput();
    const id = token(MINT_THREE, NETWORK_A, TOKEN_2022_PROGRAM_ID);
    input.assets.push({ assetId: id, display: { symbol: 'HOOK' }, origin: 'TEST_FIXTURE' });
    input.policies.push(policy(id, 'fixture-v1', { supportedExtensionProfile: 'hooked' }));
    const registry = createAssetRegistry({ ...input, allowedExtensions: ['TransferHook'] });
    expect(registry.evaluateSupport(id).supported).toBe(false);
  });
  it('rejects an unknown token program, an unknown profile and a missing policy', () => {
    const input = baseInput();
    const odd = token(MINT_THREE, NETWORK_A, UNKNOWN_PROGRAM);
    input.assets.push({ assetId: odd, display: { symbol: 'ODD' }, origin: 'TEST_FIXTURE' });
    input.policies.push(policy(odd));
    const unknownProfileAsset = token(MINT_THREE, NETWORK_B);
    input.assets.push({
      assetId: unknownProfileAsset,
      display: { symbol: 'NOPROFILE' },
      origin: 'TEST_FIXTURE',
    });
    input.policies.push(
      policy(unknownProfileAsset, 'fixture-v1', { supportedExtensionProfile: 'unlisted' }),
    );
    const noPolicy = native(NETWORK_B);
    input.assets.push({ assetId: noPolicy, display: { symbol: 'SOLB' }, origin: 'TEST_FIXTURE' });
    const registry = createAssetRegistry(input);
    expect(registry.evaluateSupport(odd).reasons).toContain('UNKNOWN_TOKEN_PROGRAM');
    expect(registry.evaluateSupport(unknownProfileAsset).reasons).toContain(
      'UNKNOWN_EXTENSION_PROFILE',
    );
    expect(registry.evaluateSupport(noPolicy).reasons).toContain('NO_POLICY');
    expect(codeOf(() => registry.evaluateSupport(token('0OIl')))).toBe('INVALID_ASSET_ID');
  });
  it('rejects a native SOL asset whose profile declares any extension', () => {
    const input = baseInput();
    const sol = native(NETWORK_B);
    input.assets.push({ assetId: sol, display: { symbol: 'SOLB' }, origin: 'TEST_FIXTURE' });
    input.policies.push(
      policy(sol, 'fixture-v1', {
        verifiedDecimals: 9,
        supportedExtensionProfile: 'metadata-only',
      }),
    );
    const registry = createAssetRegistry(input);
    expect(registry.evaluateSupport(sol)).toEqual({
      supported: false,
      reasons: ['EXTENSIONS_ON_NATIVE_ASSET'],
    });
    expect(registry.evaluateSupport(native()).supported).toBe(true);
  });
  it('rejects a plain SPL token program asset that claims extensions', () => {
    const input = baseInput();
    const id = token(MINT_THREE);
    input.assets.push({ assetId: id, display: { symbol: 'LIE' }, origin: 'TEST_FIXTURE' });
    input.policies.push(policy(id, 'fixture-v1', { supportedExtensionProfile: 'metadata-only' }));
    const registry = createAssetRegistry({ ...input, allowedExtensions: ['MetadataPointer'] });
    expect(registry.evaluateSupport(id).reasons).toContain('EXTENSIONS_ON_LEGACY_PROGRAM');
  });
});
