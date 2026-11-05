import { describe, expect, it } from 'vitest';
import { UUID_PATTERN, isLowercaseUuid } from '../src/lib/uuid-pattern';

describe('shared lowercase uuid pattern', () => {
  it('matches only a canonical lowercase uuid', () => {
    const id = 'abcdef01-2345-4678-89ab-cdef01234567';
    expect(isLowercaseUuid(id)).toBe(true);
    expect(isLowercaseUuid(id.toUpperCase())).toBe(false);
    expect(isLowercaseUuid(`${id}x`)).toBe(false);
    expect(isLowercaseUuid(`x${id}`)).toBe(false);
    expect(new RegExp(`^${UUID_PATTERN}$`).test(id)).toBe(true);
  });
});
