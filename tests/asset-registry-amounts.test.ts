import { describe, expect, it } from 'vitest';
import {
  AssetRegistryError,
  MAX_SPLIT_RECIPIENTS,
  U64_MAX,
  checkedAdd,
  checkedSub,
  computeFee,
  formatAmount,
  fromJsonAmount,
  parseAmount,
  splitProportional,
  sumAmounts,
  toJsonAmount,
} from '../src/asset-registry';
import { formatDisplayAmount, parseDisplayAmount } from '../src/contracts';
import { codeOf, mulberry32, randomBigint } from './helpers/asset-fixtures';

describe('T029 exact bounded amount parsing and formatting (16.3)', () => {
  it('parses the section 16.3 example exactly and formats it back', () => {
    expect(parseAmount('250.50', 6)).toBe(250_500_000n);
    expect(formatAmount(250_500_000n, 6)).toBe('250.5');
    expect(parseAmount('0', 6)).toBe(0n);
    expect(parseAmount('7', 0)).toBe(7n);
    expect(formatAmount(0n, 6)).toBe('0');
    expect(formatAmount(5n, 9)).toBe('0.000000005');
  });
  it('rejects excess precision instead of rounding', () => {
    expect(codeOf(() => parseAmount('1.1234567', 6))).toBe('EXCESS_PRECISION');
    expect(codeOf(() => parseAmount('1.5', 0))).toBe('EXCESS_PRECISION');
    expect(codeOf(() => parseAmount('0.0000001', 6))).toBe('EXCESS_PRECISION');
  });
  it.each([
    '',
    ' 1',
    '1 ',
    '-1',
    '+1',
    '1e3',
    '0x10',
    '.5',
    '1.',
    '01',
    '1,000',
    'NaN',
    'Infinity',
    '1..2',
    '１２３',
    '1\n',
  ])('rejects malformed display amount %j', (value) => {
    expect(codeOf(() => parseAmount(value, 6))).toBe('INVALID_AMOUNT');
  });
  it('rejects non-string input including JavaScript numbers', () => {
    expect(codeOf(() => parseAmount(1.5 as unknown as string, 6))).toBe('INVALID_AMOUNT');
    expect(codeOf(() => parseAmount(10n as unknown as string, 6))).toBe('INVALID_AMOUNT');
    expect(codeOf(() => parseAmount(undefined as unknown as string, 6))).toBe('INVALID_AMOUNT');
  });
  it('validates decimals and the host bound', () => {
    expect(codeOf(() => parseAmount('1', -1))).toBe('INVALID_AMOUNT');
    expect(codeOf(() => parseAmount('1', 256))).toBe('INVALID_AMOUNT');
    expect(codeOf(() => parseAmount('1', 1.5))).toBe('INVALID_AMOUNT');
    expect(codeOf(() => parseAmount('1', 6, -1n))).toBe('INVALID_AMOUNT');
  });
  it('enforces the inclusive u64 upper bound by default', () => {
    expect(U64_MAX).toBe(18_446_744_073_709_551_615n);
    expect(parseAmount('18446744073709551615', 0)).toBe(U64_MAX);
    expect(codeOf(() => parseAmount('18446744073709551616', 0))).toBe('AMOUNT_OVERFLOW');
    expect(parseAmount('18446744073709.551615', 6)).toBe(U64_MAX);
    expect(codeOf(() => parseAmount('18446744073709.551616', 6))).toBe('AMOUNT_OVERFLOW');
    expect(codeOf(() => parseAmount('11', 0, 10n))).toBe('AMOUNT_OVERFLOW');
    expect(parseAmount('10', 0, 10n)).toBe(10n);
  });
  it('formats only in-bound nonnegative integers', () => {
    expect(codeOf(() => formatAmount(-1n, 6))).toBe('INVALID_AMOUNT');
    expect(codeOf(() => formatAmount(U64_MAX + 1n, 6))).toBe('AMOUNT_OVERFLOW');
    expect(codeOf(() => formatAmount(1 as unknown as bigint, 6))).toBe('INVALID_AMOUNT');
  });
  it('agrees with the shared T002 contract helpers (reuse, no divergence)', () => {
    const random = mulberry32(2902);
    for (let i = 0; i < 400; i++) {
      const decimals = Math.floor(random() * 19);
      const raw = randomBigint(random, U64_MAX + 1n);
      const display = formatAmount(raw, decimals);
      expect(display).toBe(formatDisplayAmount(raw.toString(), decimals));
      expect(parseAmount(display, decimals)).toBe(raw);
      expect(parseDisplayAmount(display, decimals, U64_MAX)).toBe(raw.toString());
    }
  });
  it('round trips random amounts for every decimals value without precision loss (property)', () => {
    const random = mulberry32(29);
    for (let decimals = 0; decimals <= 255; decimals += 5) {
      for (let i = 0; i < 20; i++) {
        const raw = randomBigint(random, U64_MAX + 1n);
        expect(parseAmount(formatAmount(raw, decimals), decimals)).toBe(raw);
      }
    }
  });
});

describe('T029 checked arithmetic', () => {
  it('adds, subtracts and sums exactly within the bound', () => {
    expect(checkedAdd(1n, 2n)).toBe(3n);
    expect(checkedAdd(U64_MAX, 0n)).toBe(U64_MAX);
    expect(checkedSub(5n, 5n)).toBe(0n);
    expect(sumAmounts([1n, 2n, 3n])).toBe(6n);
    expect(sumAmounts([])).toBe(0n);
  });
  it('rejects overflow, underflow and non-bigint input', () => {
    expect(codeOf(() => checkedAdd(U64_MAX, 1n))).toBe('AMOUNT_OVERFLOW');
    expect(codeOf(() => checkedAdd(6n, 5n, 10n))).toBe('AMOUNT_OVERFLOW');
    expect(codeOf(() => checkedSub(1n, 2n))).toBe('AMOUNT_UNDERFLOW');
    expect(codeOf(() => sumAmounts([U64_MAX, 1n]))).toBe('AMOUNT_OVERFLOW');
    expect(codeOf(() => checkedAdd(1 as unknown as bigint, 2n))).toBe('INVALID_AMOUNT');
    expect(codeOf(() => checkedAdd(-1n, 2n))).toBe('INVALID_AMOUNT');
    expect(codeOf(() => checkedSub(U64_MAX + 1n, 0n))).toBe('AMOUNT_OVERFLOW');
  });
});

describe('T029 deterministic split with disclosed remainder rule (14.3)', () => {
  it('splits the section 14.3 example 50/30/20 exactly', () => {
    const result = splitProportional(1000n, [50n, 30n, 20n]);
    expect(result.shares).toEqual([500n, 300n, 200n]);
    expect(result.residual).toBe(0n);
    expect(result.rule).toBe('LARGEST_REMAINDER');
  });
  it('distributes remainder to the largest fractional parts, ties to the lowest index', () => {
    expect(splitProportional(10n, [1n, 1n, 1n]).shares).toEqual([4n, 3n, 3n]);
    expect(splitProportional(11n, [1n, 1n, 1n]).shares).toEqual([4n, 4n, 3n]);
    // 7 * 5/9 = 3.88.., 7 * 4/9 = 3.11..: the remainder unit goes to the larger fraction.
    expect(splitProportional(7n, [5n, 4n]).shares).toEqual([4n, 3n]);
    expect(splitProportional(1n, [1n, 1n]).shares).toEqual([1n, 0n]);
  });
  it('never gives remainder to a zero-weight recipient', () => {
    expect(splitProportional(5n, [0n, 1n, 1n]).shares).toEqual([0n, 3n, 2n]);
    expect(splitProportional(0n, [1n, 2n]).shares).toEqual([0n, 0n]);
  });
  it('can disclose the remainder as unallocated instead of assigning it', () => {
    const result = splitProportional(10n, [1n, 1n, 1n], 'UNALLOCATED');
    expect(result.shares).toEqual([3n, 3n, 3n]);
    expect(result.residual).toBe(1n);
    expect(result.rule).toBe('UNALLOCATED');
  });
  it('rejects invalid allocations', () => {
    expect(codeOf(() => splitProportional(10n, []))).toBe('INVALID_ALLOCATION');
    expect(codeOf(() => splitProportional(10n, [0n, 0n]))).toBe('INVALID_ALLOCATION');
    expect(codeOf(() => splitProportional(10n, [1n, -1n]))).toBe('INVALID_ALLOCATION');
    expect(codeOf(() => splitProportional(10n, [1.5 as unknown as bigint]))).toBe(
      'INVALID_ALLOCATION',
    );
    expect(codeOf(() => splitProportional(-1n, [1n]))).toBe('INVALID_AMOUNT');
    expect(codeOf(() => splitProportional(U64_MAX + 1n, [1n]))).toBe('AMOUNT_OVERFLOW');
    expect(codeOf(() => splitProportional(10n, [1n], 'ROUND_UP' as never))).toBe(
      'INVALID_ALLOCATION',
    );
  });
  it('caps the number of recipients at 1024', () => {
    expect(MAX_SPLIT_RECIPIENTS).toBe(1024);
    const atCap = splitProportional(5000n, Array(1024).fill(1n));
    expect(atCap.shares).toHaveLength(1024);
    expect(sumAmounts(atCap.shares)).toBe(5000n);
    expect(codeOf(() => splitProportional(5000n, Array(1025).fill(1n)))).toBe('INVALID_ALLOCATION');
  });
  it('conserves the total, is never negative and is deterministic (property)', () => {
    const random = mulberry32(14);
    for (let i = 0; i < 600; i++) {
      const total = randomBigint(random, i % 3 === 0 ? U64_MAX + 1n : 10_000n);
      const count = 1 + Math.floor(random() * 8);
      const weights: bigint[] = Array.from({ length: count }, () =>
        randomBigint(random, 1_000_000n),
      );
      if (sumAmounts(weights) === 0n) weights[0] = 1n;
      for (const rule of ['LARGEST_REMAINDER', 'UNALLOCATED'] as const) {
        const first = splitProportional(total, weights, rule);
        const again = splitProportional(total, [...weights], rule);
        expect(again).toEqual(first);
        expect(first.shares).toHaveLength(count);
        for (const share of first.shares) expect(share >= 0n).toBe(true);
        expect(first.residual >= 0n).toBe(true);
        expect(sumAmounts(first.shares) + first.residual).toBe(total);
        if (rule === 'LARGEST_REMAINDER') expect(first.residual).toBe(0n);
        else expect(first.residual < BigInt(count)).toBe(true);
        weights.forEach((weight, index) => {
          if (weight === 0n) expect(first.shares[index]).toBe(0n);
        });
      }
    }
  });
  it('keeps every share within one unit of the exact proportional value (property)', () => {
    const random = mulberry32(141);
    for (let i = 0; i < 300; i++) {
      const total = randomBigint(random, 10n ** 12n);
      const weights = Array.from(
        { length: 1 + Math.floor(random() * 6) },
        () => 1n + randomBigint(random, 1000n),
      );
      const weightSum = weights.reduce((a, b) => a + b, 0n);
      const { shares } = splitProportional(total, weights);
      shares.forEach((share, index) => {
        const floor = (total * weights[index]) / weightSum;
        expect(share === floor || share === floor + 1n).toBe(true);
      });
    }
  });
});

describe('T029 fee calculation is a separate exact function', () => {
  it('floors or ceils basis points exactly and never exceeds the amount', () => {
    expect(computeFee(1000n, 250, 'FLOOR')).toBe(25n);
    expect(computeFee(999n, 250, 'FLOOR')).toBe(24n);
    expect(computeFee(999n, 250, 'CEIL')).toBe(25n);
    expect(computeFee(0n, 250, 'CEIL')).toBe(0n);
    expect(computeFee(123n, 0, 'CEIL')).toBe(0n);
    expect(computeFee(123n, 10_000, 'CEIL')).toBe(123n);
    expect(computeFee(U64_MAX, 10_000, 'FLOOR')).toBe(U64_MAX);
  });
  it('rejects unreasonable basis points and rounding names', () => {
    expect(codeOf(() => computeFee(1n, 10_001, 'FLOOR'))).toBe('INVALID_ALLOCATION');
    expect(codeOf(() => computeFee(1n, -1, 'FLOOR'))).toBe('INVALID_ALLOCATION');
    expect(codeOf(() => computeFee(1n, 1.5, 'FLOOR'))).toBe('INVALID_ALLOCATION');
    expect(codeOf(() => computeFee(1n, 1, 'NEAREST' as never))).toBe('INVALID_ALLOCATION');
  });
});

describe('T029 JSON decimal-string serialization', () => {
  it('serializes amounts as canonical decimal strings and parses them back', () => {
    expect(toJsonAmount(250_500_000n)).toBe('250500000');
    expect(toJsonAmount(U64_MAX)).toBe('18446744073709551615');
    expect(JSON.stringify({ amount: toJsonAmount(5n) })).toBe('{"amount":"5"}');
    expect(fromJsonAmount('18446744073709551615')).toBe(U64_MAX);
    expect(fromJsonAmount('0')).toBe(0n);
  });
  it('rejects JSON numbers, noncanonical strings and out-of-bound values', () => {
    expect(codeOf(() => fromJsonAmount(5))).toBe('INVALID_AMOUNT');
    expect(codeOf(() => fromJsonAmount(Number.MAX_SAFE_INTEGER + 2))).toBe('INVALID_AMOUNT');
    expect(codeOf(() => fromJsonAmount('007'))).toBe('INVALID_AMOUNT');
    expect(codeOf(() => fromJsonAmount('1.0'))).toBe('INVALID_AMOUNT');
    expect(codeOf(() => fromJsonAmount('-1'))).toBe('INVALID_AMOUNT');
    expect(codeOf(() => fromJsonAmount(null))).toBe('INVALID_AMOUNT');
    expect(codeOf(() => fromJsonAmount('18446744073709551616'))).toBe('AMOUNT_OVERFLOW');
    expect(codeOf(() => toJsonAmount(-1n))).toBe('INVALID_AMOUNT');
  });
  it('round trips large random amounts exactly (property)', () => {
    const random = mulberry32(7);
    for (let i = 0; i < 300; i++) {
      const raw = randomBigint(random, U64_MAX + 1n);
      expect(fromJsonAmount(JSON.parse(JSON.stringify(toJsonAmount(raw))))).toBe(raw);
    }
  });
});

describe('T029 error shape', () => {
  it('exposes only a machine code, never input text', () => {
    try {
      parseAmount('secret-looking-input', 6);
    } catch (error) {
      expect(error).toBeInstanceOf(AssetRegistryError);
      expect((error as Error).message).toBe('INVALID_AMOUNT');
      expect(String((error as Error).stack)).not.toContain('secret-looking-input');
      return;
    }
    throw new Error('expected rejection');
  });
});
