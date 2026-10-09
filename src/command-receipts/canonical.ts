import { createHash } from 'node:crypto';
import { CommandReceiptError } from './contracts';

const MAX_DEPTH = 32;
const MAX_LENGTH = 65_536;
const DIGEST_DOMAIN = 'raid.command-receipts.v1\n';

function invalid(): never {
  throw new CommandReceiptError('INVALID_INPUT');
}
function canonical(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) invalid();
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    // Integers beyond 2^53 lose identity as JSON numbers; amounts must travel as decimal strings.
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
      invalid();
    return Object.is(value, -0) ? '0' : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) invalid();
      items.push(canonical(value[index], depth + 1));
    }
    return `[${items.join(',')}]`;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key], depth + 1)}`);
    return `{${entries.join(',')}}`;
  }
  return invalid();
}
/**
 * Deterministic SHA-256 (lowercase hex) of a JSON-compatible value. Key order is irrelevant; `undefined`,
 * bigint, Date, Map, functions, non-finite or unsafe numbers and over-deep or over-long values are
 * rejected so two different requests can never share a digest through coercion.
 */
export function canonicalRequestDigest(value: unknown): string {
  const text = canonical(value, 0);
  if (text.length > MAX_LENGTH) invalid();
  return createHash('sha256').update(`${DIGEST_DOMAIN}${text}`).digest('hex');
}
