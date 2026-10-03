import { describe, it, expect, afterEach } from 'vitest';
import { formatNumber, formatUtcDate, formatUtcDateTime } from '../src/lib/format';

describe('deterministic formatting', () => {
  const zone = process.env.TZ;
  afterEach(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });
  it('pins the locale for numbers', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatNumber(null)).toBe('');
    expect(formatNumber(undefined)).toBe('');
  });
  it('renders UTC dates regardless of the process time zone', () => {
    process.env.TZ = 'Asia/Kathmandu';
    expect(formatUtcDateTime('2026-09-27T23:30:00Z')).toBe('Sep 27, 2026, 11:30 PM UTC');
    expect(formatUtcDateTime(new Date('2026-09-27T23:30:00Z'))).toBe('Sep 27, 2026, 11:30 PM UTC');
    expect(formatUtcDate('2026-09-27T23:30:00Z')).toBe('Sep 27, 2026');
    process.env.TZ = 'America/Los_Angeles';
    expect(formatUtcDate('2026-09-27T01:30:00Z')).toBe('Sep 27, 2026');
  });
});
