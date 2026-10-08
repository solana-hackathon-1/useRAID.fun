import { z } from 'zod';
import bs58 from 'bs58';
import { InternalId, UtcTimestamp } from './ids';
export const SolanaAddress = z.string().refine((value) => {
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}, 'Expected a 32-byte base58 address.');
const network = { chain: z.literal('SOLANA'), networkIdentity: InternalId };
export const TokenAssetIdSchema = z
  .strictObject({
    ...network,
    kind: z.literal('TOKEN'),
    mint: SolanaAddress,
    tokenProgram: SolanaAddress,
  })
  .readonly();
export const AssetIdSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...network, kind: z.literal('NATIVE_SOL') }).readonly(),
  TokenAssetIdSchema,
]);
export type AssetId = z.infer<typeof AssetIdSchema>;
export const AmountSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .brand<'BaseUnits'>();
export type BaseUnits = z.infer<typeof AmountSchema>;
export const AssetDecimals = z.number().int().min(0).max(255);
export const AssetPolicySnapshotSchema = z
  .strictObject({
    assetId: AssetIdSchema,
    registryVersion: InternalId,
    verifiedDecimals: AssetDecimals,
    observedAuthorities: z.array(SolanaAddress).readonly(),
    supportedExtensionProfile: InternalId,
    observedAt: UtcTimestamp,
    observedSlot: AmountSchema,
  })
  .readonly();
export type AssetPolicySnapshot = z.infer<typeof AssetPolicySnapshotSchema>;
/** Registry revision and display labels never create a new instrument or balance. */
export function assetKey(value: z.input<typeof AssetIdSchema>): string {
  const asset = AssetIdSchema.parse(value);
  return JSON.stringify(
    asset.kind === 'TOKEN'
      ? [asset.chain, asset.networkIdentity, asset.kind, asset.mint, asset.tokenProgram]
      : [asset.chain, asset.networkIdentity, asset.kind],
  );
}
/** Host supplies the actual program/storage bound; this never enables an asset. */
export function parseDisplayAmount(value: string, decimals: number, maximum: bigint): BaseUnits {
  AssetDecimals.parse(decimals);
  if (typeof maximum !== 'bigint' || maximum < 0n) throw new Error('Invalid amount bound.');
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(\.\d+)?$/.test(value))
    throw new Error('Invalid display amount.');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new Error('Excess fractional precision.');
  const amount =
    BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (amount > maximum) throw new Error('Amount exceeds host bound.');
  return AmountSchema.parse(amount.toString());
}
export function formatDisplayAmount(value: string, decimals: number): string {
  const raw = AmountSchema.parse(value);
  AssetDecimals.parse(decimals);
  if (decimals === 0) return raw;
  const digits = raw.padStart(decimals + 1, '0');
  const fraction = digits.slice(-decimals).replace(/0+$/, '');
  return digits.slice(0, -decimals) + (fraction ? `.${fraction}` : '');
}
