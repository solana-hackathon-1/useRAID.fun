import { Connection, PublicKey } from '@solana/web3.js';
import { HttpError } from '../auth-primitives';
import { config } from '../config';
import { launchTemplate, parseUnits, type MeteoraNetwork } from './amounts';
export function meteoraNetwork(): MeteoraNetwork {
  const value = process.env.METEORA_NETWORK || 'devnet';
  if (value !== 'devnet' && value !== 'mainnet')
    throw new HttpError(503, 'Select devnet or mainnet for Meteora.');
  return value;
}
// True while the Meteora switch is on. Pump launchpad routes stay behind launchpadsAvailable regardless.
export const meteoraLaunchSwitch = () => process.env.METEORA_LAUNCH_ENABLED === 'true';
export function meteoraReadiness() {
  const network = meteoraNetwork(),
    issues: string[] = [];
  if (process.env.METEORA_LAUNCH_ENABLED !== 'true')
    issues.push('Token launches are not enabled yet.');
  if (config.demo) issues.push('Preview mode does not submit transactions.');
  if (!process.env.METEORA_RPC_URL?.startsWith('https://'))
    issues.push('Solana RPC needs configuration.');
  if (!process.env.PINATA_JWT) issues.push('Token image storage needs configuration.');
  if (
    Buffer.from(process.env[`LAUNCH_KEY_${process.env.LAUNCH_KEY_VERSION || '1'}`] || '', 'base64')
      .length !== 32
  )
    issues.push('Launch encryption needs configuration.');
  // Image upload proofs are signed with their own key (web only), never with the launch encryption key.
  if (Buffer.from(process.env.LAUNCH_ASSET_KEY || '', 'base64').length !== 32)
    issues.push('Launch image verification needs configuration.');
  try {
    new PublicKey(process.env.METEORA_OPERATOR_PUBLIC_KEY || '');
  } catch {
    issues.push('Worker wallet needs configuration.');
  }
  try {
    const name = new URL(process.env.DATABASE_URL || '').pathname;
    if (network === 'devnet' && name !== '/useraid_meteora_devnet')
      issues.push('Devnet requires isolated useraid_meteora_devnet database.');
    if (network === 'mainnet' && /devnet|test|sandbox/.test(name))
      issues.push('Mainnet requires production database.');
  } catch {
    issues.push('Launch database needs configuration.');
  }
  if (network === 'mainnet') {
    if (process.env.METEORA_MAINNET_APPROVED !== 'true')
      issues.push('Mainnet pilot is not approved.');
    if (process.env.METEORA_DEVNET_ACCEPTED !== 'true')
      issues.push('Devnet lifecycle acceptance is not complete.');
    if (
      !config.liveApproved ||
      !process.env.X_BEARER_TOKEN ||
      process.env.X_TRACKING_V2_SETTLEMENT_ENABLED !== 'true'
    )
      issues.push('Production X tracking and settlement need verification.');
    for (const [key, decimals] of [
      ['METEORA_MAX_CUSTODY_SOL', 9],
      ['METEORA_MAX_PAYOUT_SOL', 9],
      ['METEORA_MAX_PAYOUT_TOKENS', 6],
    ] as const) {
      try {
        parseUnits(process.env[key] || '', decimals);
      } catch {
        issues.push(`${key} needs an approved limit.`);
      }
    }
  }
  return { enabled: !issues.length, network, issues, template: launchTemplate(network) };
}
export function assertMeteoraEnabled() {
  const state = meteoraReadiness();
  if (!state.enabled) throw new HttpError(503, state.issues[0]);
  return state;
}
export function meteoraConnection(network = meteoraNetwork()) {
  if (network !== meteoraNetwork()) throw new HttpError(409, 'Launch belongs to another network.');
  const endpoint = process.env.METEORA_RPC_URL;
  if (!endpoint?.startsWith('https://'))
    throw new HttpError(503, 'Solana RPC needs configuration.');
  return new Connection(endpoint, 'finalized');
}
export async function assertMeteoraNetwork(rpc: Connection, network = meteoraNetwork()) {
  const genesis = await rpc.getGenesisHash();
  const expected =
    network === 'mainnet'
      ? '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
      : 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
  if (genesis !== expected) throw new HttpError(503, `Solana RPC must point to ${network}.`);
}
export function explorerUrl(signature: string, network: string) {
  return `https://solscan.io/tx/${encodeURIComponent(signature)}${network === 'devnet' ? '?cluster=devnet' : ''}`;
}
