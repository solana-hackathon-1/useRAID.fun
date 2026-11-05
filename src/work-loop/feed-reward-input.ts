import { parseDisplayAmount, type AssetId, type BaseUnits } from '../contracts/assets';
import type { FeedAsset } from './feed-contracts';

/**
 * Display-unit minimum reward input (blueprint §16.3, §18.2, I03). A person types an amount in the one selected
 * asset's display units (for example `1.5` USDC); this converts it exactly, with integer arithmetic and the asset's
 * verified decimals, to the base units the feed query takes. There is no floating point, no rounding and no exchange
 * rate: a value that does not fit the asset exactly is refused with a message saying how to fix it.
 */
const U64_MAX = 2n ** 64n - 1n;
/** A longer string cannot be a valid amount (20 digits, a point and up to 255 decimals is far past any real asset). */
const MAX_INPUT = 64;
export type RewardInputProblem =
  | 'NEEDS_ASSET'
  | 'DECIMALS_UNKNOWN'
  | 'EMPTY'
  | 'NEGATIVE'
  | 'FORMAT'
  | 'TOO_MANY_DECIMALS'
  | 'TOO_LARGE';
export type RewardMinimum =
  { ok: true; baseUnits: BaseUnits } | { ok: false; problem: RewardInputProblem; message: string };
/** The selected reward asset as the form knows it; `decimals` is null when live listings disagree about it. */
export interface RewardUnit {
  label: string;
  decimals: number | null;
}
const refuse = (problem: RewardInputProblem, message: string): RewardMinimum => ({
  ok: false,
  problem,
  message,
});
/**
 * What the feed page hands the minimum-reward control: closed by default behind its own flag; otherwise the live
 * reward assets with their decimals, the display-unit text as typed and the one problem with it, if any.
 */
export interface RewardControl {
  enabled: boolean;
  assets: FeedAsset[];
  amount: string;
  problem: string | null;
}
/** The short public label of a reward asset: SOL, or a token's abbreviated mint. Display only; identity is `assetKey`. */
export function feedAssetLabel(asset: AssetId) {
  return asset.kind === 'NATIVE_SOL' ? 'SOL' : `${asset.mint.slice(0, 4)}…${asset.mint.slice(-4)}`;
}
/** Plain words for the allowed precision. */
export function decimalPlaces(decimals: number) {
  return decimals === 0
    ? 'whole numbers only (no decimal point)'
    : `at most ${decimals} decimal ${decimals === 1 ? 'place' : 'places'}`;
}
/**
 * The exact base units of `input` in the asset's display units, or the one problem to fix. Messages are fixed text
 * plus the asset's own label and decimals; the typed text is never echoed into them.
 */
export function parseRewardMinimum(input: string, asset: RewardUnit | null): RewardMinimum {
  if (asset === null)
    return refuse(
      'NEEDS_ASSET',
      'Choose a reward asset to set a minimum. Amounts in different assets are never compared or converted.',
    );
  if (asset.decimals === null)
    return refuse(
      'DECIMALS_UNKNOWN',
      `The precision of ${asset.label} is not confirmed right now, so a minimum cannot be set safely. Clear the minimum or choose another asset.`,
    );
  const text = typeof input === 'string' ? input.trim() : '';
  if (text === '')
    return refuse(
      'EMPTY',
      'Enter an amount such as 1.5, or clear the field to ignore the minimum.',
    );
  if (/^[-−]/.test(text))
    return refuse('NEGATIVE', 'A minimum reward cannot be negative. Enter zero or more.');
  if (text.length > MAX_INPUT || !/^(0|[1-9]\d*)(\.\d+)?$/.test(text))
    return refuse(
      'FORMAT',
      /,/.test(text)
        ? 'Use a period, not a comma, for the decimal point, and no thousands separators. For example 1.5.'
        : 'Enter digits with an optional decimal point, for example 1.5. Letters, signs, spaces, exponents and leading zeros are not accepted.',
    );
  const fraction = text.split('.')[1] ?? '';
  if (fraction.length > asset.decimals)
    return refuse(
      'TOO_MANY_DECIMALS',
      `${asset.label} allows ${decimalPlaces(asset.decimals)}. Shorten the amount; it is never rounded for you.`,
    );
  try {
    return { ok: true, baseUnits: parseDisplayAmount(text, asset.decimals, U64_MAX) };
  } catch {
    return refuse(
      'TOO_LARGE',
      `That is more than ${asset.label} can hold. Enter a smaller amount.`,
    );
  }
}
