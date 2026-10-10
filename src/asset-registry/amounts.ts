import { AmountSchema, formatDisplayAmount, parseDisplayAmount } from '../contracts/assets';
import { AssetRegistryError } from './errors';

/**
 * Bounded integer arithmetic over asset base units (blueprint 16.3).
 *
 * Amounts are nonnegative `bigint` values below an explicit host bound. The default bound is the
 * unsigned 64-bit maximum, which is what SPL token amounts and lamports use on Solana. There is no
 * floating point anywhere: display strings, JSON strings and splits are all exact. Rejection is
 * always a typed `AssetRegistryError`; nothing is silently rounded, clamped or wrapped.
 */
export const U64_MAX = 18_446_744_073_709_551_615n;
export const MAX_SPLIT_RECIPIENTS = 1024;
export type RemainderRule = 'LARGEST_REMAINDER' | 'UNALLOCATED';
export type FeeRounding = 'FLOOR' | 'CEIL';
export interface SplitResult {
  /** One share per weight, in input order. */
  readonly shares: readonly bigint[];
  /** Units not assigned to any recipient (always 0n for `LARGEST_REMAINDER`). */
  readonly residual: bigint;
  /** The disclosed rule that produced these shares. */
  readonly rule: RemainderRule;
}

function assertBound(bound: unknown): asserts bound is bigint {
  if (typeof bound !== 'bigint' || bound < 0n) throw new AssetRegistryError('INVALID_AMOUNT');
}
function assertAmount(value: unknown, bound: bigint): asserts value is bigint {
  assertBound(bound);
  if (typeof value !== 'bigint' || value < 0n) throw new AssetRegistryError('INVALID_AMOUNT');
  if (value > bound) throw new AssetRegistryError('AMOUNT_OVERFLOW');
}

/** Parse a display decimal string such as `250.50` into base units; rejects excess precision. */
export function parseAmount(display: string, decimals: number, bound: bigint = U64_MAX): bigint {
  try {
    return BigInt(parseDisplayAmount(display, decimals, bound));
  } catch (error) {
    // Messages come from the shared T002 helper (pinned by tests); anything else is invalid input.
    const message = error instanceof Error ? error.message : '';
    if (message === 'Excess fractional precision.')
      throw new AssetRegistryError('EXCESS_PRECISION');
    if (message === 'Amount exceeds host bound.') throw new AssetRegistryError('AMOUNT_OVERFLOW');
    throw new AssetRegistryError('INVALID_AMOUNT');
  }
}

/** Format base units as the shortest exact display decimal string. */
export function formatAmount(amount: bigint, decimals: number, bound: bigint = U64_MAX): string {
  assertAmount(amount, bound);
  try {
    return formatDisplayAmount(amount.toString(), decimals);
  } catch {
    throw new AssetRegistryError('INVALID_AMOUNT');
  }
}

export function checkedAdd(a: bigint, b: bigint, bound: bigint = U64_MAX): bigint {
  assertAmount(a, bound);
  assertAmount(b, bound);
  const sum = a + b;
  if (sum > bound) throw new AssetRegistryError('AMOUNT_OVERFLOW');
  return sum;
}

export function checkedSub(a: bigint, b: bigint, bound: bigint = U64_MAX): bigint {
  assertAmount(a, bound);
  assertAmount(b, bound);
  if (b > a) throw new AssetRegistryError('AMOUNT_UNDERFLOW');
  return a - b;
}

export function sumAmounts(values: readonly bigint[], bound: bigint = U64_MAX): bigint {
  let total = 0n;
  for (const value of values) total = checkedAdd(total, value, bound);
  return total;
}

/**
 * Split `total` over integer weights. Percentages are just weights (50, 30, 20). Each recipient
 * receives the floor of its exact share; the leftover units follow the disclosed rule:
 * `LARGEST_REMAINDER` hands one unit each to the largest fractional parts (ties to the lowest index,
 * never to a zero weight) so the shares sum to `total`; `UNALLOCATED` leaves them as `residual`.
 */
export function splitProportional(
  total: bigint,
  weights: readonly bigint[],
  rule: RemainderRule = 'LARGEST_REMAINDER',
  bound: bigint = U64_MAX,
): SplitResult {
  assertAmount(total, bound);
  if (rule !== 'LARGEST_REMAINDER' && rule !== 'UNALLOCATED')
    throw new AssetRegistryError('INVALID_ALLOCATION');
  if (!Array.isArray(weights) || weights.length === 0 || weights.length > MAX_SPLIT_RECIPIENTS)
    throw new AssetRegistryError('INVALID_ALLOCATION');
  let weightSum = 0n;
  for (const weight of weights) {
    if (typeof weight !== 'bigint' || weight < 0n)
      throw new AssetRegistryError('INVALID_ALLOCATION');
    weightSum += weight;
  }
  if (weightSum === 0n) throw new AssetRegistryError('INVALID_ALLOCATION');
  const shares = weights.map((weight) => (total * weight) / weightSum);
  const remainders = weights.map((weight) => (total * weight) % weightSum);
  let leftover = total - shares.reduce((sum, share) => sum + share, 0n);
  if (rule === 'LARGEST_REMAINDER') {
    const order = weights
      .map((_, index) => index)
      .sort((a, b) =>
        remainders[a] === remainders[b] ? a - b : remainders[a] > remainders[b] ? -1 : 1,
      );
    for (const index of order) {
      if (leftover === 0n) break;
      shares[index] += 1n;
      leftover -= 1n;
    }
  }
  return { shares, residual: leftover, rule };
}

/** Fee in basis points of `amount`, rounded by the caller's explicit choice. Rates are not set here. */
export function computeFee(
  amount: bigint,
  basisPoints: number | bigint,
  rounding: FeeRounding,
  bound: bigint = U64_MAX,
): bigint {
  assertAmount(amount, bound);
  const integral =
    typeof basisPoints === 'bigint' ||
    (typeof basisPoints === 'number' && Number.isInteger(basisPoints));
  if (!integral || (rounding !== 'FLOOR' && rounding !== 'CEIL'))
    throw new AssetRegistryError('INVALID_ALLOCATION');
  const bps = BigInt(basisPoints);
  if (bps < 0n || bps > 10_000n) throw new AssetRegistryError('INVALID_ALLOCATION');
  const numerator = amount * bps;
  return rounding === 'FLOOR' ? numerator / 10_000n : (numerator + 9_999n) / 10_000n;
}

/** Canonical JSON form: a base-10 integer string. JSON numbers are never produced or accepted. */
export function toJsonAmount(amount: bigint, bound: bigint = U64_MAX): string {
  assertAmount(amount, bound);
  return AmountSchema.parse(amount.toString());
}

export function fromJsonAmount(value: unknown, bound: bigint = U64_MAX): bigint {
  assertBound(bound);
  if (typeof value !== 'string' || !AmountSchema.safeParse(value).success)
    throw new AssetRegistryError('INVALID_AMOUNT');
  if (value.length > bound.toString().length) throw new AssetRegistryError('AMOUNT_OVERFLOW');
  const amount = BigInt(value);
  if (amount > bound) throw new AssetRegistryError('AMOUNT_OVERFLOW');
  return amount;
}
