import { describe, expect, it } from 'vitest';
import { parseRewardMinimum } from '../src/work-loop/feed-reward-input';

/** T097 (§16.3, §18.2, I03): a typed display amount becomes exact base units of ONE asset, or an actionable problem. */
const usdc = { label: 'USDC', decimals: 6 };
const sol = { label: 'SOL', decimals: 9 };
const whole = { label: 'Points', decimals: 0 };
const ok = (input: string, asset = usdc) => {
  const result = parseRewardMinimum(input, asset);
  if (!result.ok) throw new Error(`${input}: ${result.problem}`);
  return result.baseUnits;
};
const bad = (input: string, asset: Parameters<typeof parseRewardMinimum>[1] = usdc) => {
  const result = parseRewardMinimum(input, asset);
  if (result.ok) throw new Error(`${input}: expected a problem, got ${result.baseUnits}`);
  return result;
};

describe('parseRewardMinimum: exact conversion', () => {
  it('converts display units with the asset decimals, with no floating point', () => {
    expect(ok('1.5')).toBe('1500000');
    expect(ok('0.1')).toBe('100000');
    expect(ok('0.000001')).toBe('1');
    expect(ok('250')).toBe('250000000');
    expect(ok('0')).toBe('0');
    expect(ok('1.5', sol)).toBe('1500000000');
    expect(ok('42', whole)).toBe('42');
  });
  it('is exact where binary floating point is not', () => {
    // 0.1 + 0.2 style and >2^53 values: every digit survives.
    expect(ok('0.30000000000000004', { label: 'X', decimals: 17 })).toBe('30000000000000004');
    expect(ok('9007199254740993', whole)).toBe('9007199254740993');
    expect(ok('9007199254740.993', { label: 'X', decimals: 3 })).toBe('9007199254740993');
    expect(ok('1.005')).toBe('1005000');
  });
  it('trims surrounding whitespace but nothing inside', () => {
    expect(ok('  1.5  ')).toBe('1500000');
    expect(bad('1 000').problem).toBe('FORMAT');
  });
  it('accepts the largest 64-bit amount and refuses one more base unit', () => {
    expect(ok('18446744073709.551615')).toBe('18446744073709551615');
    expect(bad('18446744073709.551616').problem).toBe('TOO_LARGE');
    expect(ok('18446744073.709551615', sol)).toBe('18446744073709551615');
    expect(bad('99999999999999999999999999', whole).problem).toBe('TOO_LARGE');
    expect(bad('1', { label: 'X', decimals: 255 }).problem).toBe('TOO_LARGE');
  });
});

describe('parseRewardMinimum: refusals are specific and actionable', () => {
  it('refuses more decimal places than the asset has, never rounding', () => {
    const result = bad('0.0000001');
    expect(result.problem).toBe('TOO_MANY_DECIMALS');
    expect(result.message).toContain('USDC');
    expect(result.message).toContain('6 decimal places');
    expect(bad('1.50', whole).message).toContain('whole numbers');
    expect(bad('1.5', whole).problem).toBe('TOO_MANY_DECIMALS');
    // Trailing zeros past the asset precision are still refused: the typed value is never reinterpreted.
    expect(bad('1.0000000').problem).toBe('TOO_MANY_DECIMALS');
  });
  it('refuses negative amounts', () => {
    for (const input of ['-1', '-0', '-0.5', '−1']) {
      expect(bad(input).problem, input).toBe('NEGATIVE');
      expect(bad(input).message, input).toContain('zero or more');
    }
  });
  it('refuses empty and blank input', () => {
    expect(bad('').problem).toBe('EMPTY');
    expect(bad('   ').problem).toBe('EMPTY');
    expect(bad('').message).toContain('clear');
  });
  it('refuses anything that is not a plain decimal', () => {
    for (const input of [
      'abc',
      '1e3',
      '1,5',
      '.5',
      '5.',
      '+1',
      '0x10',
      '1.2.3',
      '١٢٣',
      'NaN',
      'Infinity',
      '007',
    ])
      expect(bad(input).problem, input).toBe('FORMAT');
    expect(bad('1,5').message).toContain('period');
  });
  it('refuses over-long input before doing arithmetic', () => {
    expect(bad('9'.repeat(200)).problem).toBe('FORMAT');
  });
  it('never invents a unit: it needs one asset with known decimals', () => {
    expect(parseRewardMinimum('1.5', null)).toMatchObject({ ok: false, problem: 'NEEDS_ASSET' });
    expect(parseRewardMinimum('1.5', { label: 'USDC', decimals: null })).toMatchObject({
      ok: false,
      problem: 'DECIMALS_UNKNOWN',
    });
    expect(bad('1.5', null).message).toContain('reward asset');
  });
  it('never echoes the typed text inside markup-significant output beyond the fixed message', () => {
    expect(bad('<script>').message).not.toContain('<script>');
  });
});
