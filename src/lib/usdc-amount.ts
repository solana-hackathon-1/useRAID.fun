import { HttpError } from './errors';
export function units(value: string) {
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(value))
    throw new HttpError(400, 'Enter a positive USDC amount with up to six decimals.');
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (amount <= 0n) throw new HttpError(400, 'Amount must be greater than zero.');
  return amount;
}
export function formatUsdc(amount: bigint | string) {
  const n = BigInt(amount),
    negative = n < 0n,
    absolute = negative ? -n : n;
  const fraction = (absolute % 1_000_000n)
    .toString()
    .padStart(6, '0')
    .replace(/0+$/, '')
    .padEnd(2, '0');
  return `${negative ? '-' : ''}${(absolute / 1_000_000n).toLocaleString('en-US')}.${fraction}`;
}
export function quoteUsdc(target: number, rate: bigint) {
  if (!Number.isSafeInteger(target) || target < 1000 || target > 1_000_000_000 || rate <= 0n)
    throw new HttpError(400, 'Choose an impression target from 1,000 to 1 billion.');
  const amount = (BigInt(target) * rate + 999n) / 1000n;
  if (amount > 999_999_999_000_000n)
    throw new HttpError(400, 'Reward pool exceeds supported amount.');
  return amount;
}
