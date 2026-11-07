import type { AssetId } from '../contracts/assets';
import { SPL_TOKEN_PROGRAM_ID, type RegisteredAssetInput } from './registry';

/**
 * Canonical USDC on Solana: the only first-release Raid funding asset (DEC-2026-11-07-03, O07).
 *
 * The mints equal `USDC_MINTS` in `src/lib/usdc.ts`; this module cannot import application code, so
 * `tests/asset-registry-usdc.test.ts` pins the equality instead. Network identities are the public
 * Solana cluster genesis hashes. Nothing here proves the mint exists or has 6 decimals: gate G04
 * (chain verification) is still required before enablement, and the host owns that claim.
 *
 * Freeze authority on the mint is accepted by decision: a transfer blocked after funding is a
 * settlement incident that keeps the obligation; it is never a reason to discharge it (16.5).
 */
export const USDC_DECISION_REF = 'DEC-2026-11-07-03';
export const SOLANA_MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const SOLANA_DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const USDC_MAINNET_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDC_DEVNET_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

type TokenAssetId = Extract<AssetId, { kind: 'TOKEN' }>;
const usdc = (networkIdentity: string, mint: string): TokenAssetId =>
  Object.freeze({
    chain: 'SOLANA',
    networkIdentity,
    kind: 'TOKEN',
    mint,
    tokenProgram: SPL_TOKEN_PROGRAM_ID,
  } as const);

export const USDC_MAINNET_ASSET_ID: TokenAssetId = usdc(SOLANA_MAINNET_GENESIS, USDC_MAINNET_MINT);
/** Devnet only. Never added to the production allow list; production requires a MAINNET cluster. */
export const USDC_DEVNET_ASSET_ID: TokenAssetId = usdc(SOLANA_DEVNET_GENESIS, USDC_DEVNET_MINT);

export const USDC_DEVNET_REGISTRY_ENTRY: RegisteredAssetInput = Object.freeze({
  assetId: USDC_DEVNET_ASSET_ID,
  display: Object.freeze({ symbol: 'USDC', name: 'USD Coin (devnet)' }),
  origin: 'CHAIN_VERIFIED',
  approval: Object.freeze({ decisionRef: USDC_DECISION_REF }),
});
