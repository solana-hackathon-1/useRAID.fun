export const SOL_ASSET = 'SOL';
export const TOTAL_SUPPLY_UNITS = 1_000_000_000_000_000n;
export const RESERVE_UNITS = 50_000_000_000_000n;
export function parseUnits(value: string, decimals: number): bigint {
  if (!/^\d+(?:\.\d+)?$/.test(value) || value.length > 40)
    throw new Error('Enter a positive amount.');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new Error(`Use at most ${decimals} decimal places.`);
  const units =
    BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (units <= 0n || units > 18_446_744_073_709_551_615n)
    throw new Error('Amount is out of range.');
  return units;
}
export function formatUnits(value: string | bigint, decimals = 9) {
  const units = BigInt(value),
    scale = 10n ** BigInt(decimals);
  return `${units / scale}${units % scale ? `.${(units % scale).toString().padStart(decimals, '0').replace(/0+$/, '')}` : ''}`;
}
export function splitFees(units: bigint) {
  if (units < 0n) throw new Error('Invalid fee amount.');
  const campaign = (units * 20n) / 100n;
  return { creator: units - campaign, campaign, protocol: 0n };
}
export function assertSupply(parts: bigint[], supply = TOTAL_SUPPLY_UNITS) {
  if (parts.some((p) => p < 0n) || parts.reduce((a, b) => a + b, 0n) !== supply)
    throw new Error('Fixed supply accounting mismatch.');
}
export type MeteoraNetwork = 'devnet' | 'mainnet';
export const launchTemplate = (network: MeteoraNetwork) => ({
  version: 1,
  provider: 'METEORA',
  network,
  totalSupply: '1000000000',
  decimals: 6,
  migrationSupplyPercentage: 20,
  reserveTokens: '50000000',
  creatorShareBps: 8000,
  campaignShareBps: 2000,
  platformShareBps: 0,
  tradingFeeBps: 100,
  dynamicFees: false,
  immutable: true,
  lpPermanentlyLocked: true,
  graduationSol: network === 'devnet' ? '1' : '10',
  minimumCampaignSol: network === 'devnet' ? '0.01' : '0.1',
});
export type LaunchTemplate = ReturnType<typeof launchTemplate>;
