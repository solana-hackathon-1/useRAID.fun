import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SUBMISSION_RATE_LIMIT,
  practiceSubmissionRateLimit,
} from '../src/lib/practice-portal-host';

describe('T014 submission rate-limit host configuration (DEFAULT, not owner policy)', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('uses the documented conservative default when nothing is configured', () => {
    expect(practiceSubmissionRateLimit()).toEqual({ max: 10, windowSeconds: 3600 });
    expect(DEFAULT_SUBMISSION_RATE_LIMIT).toEqual({ max: 10, windowSeconds: 3600 });
  });
  it('accepts valid integer overrides', () => {
    vi.stubEnv('PRACTICE_SUBMISSION_RATE_LIMIT_MAX', '3');
    vi.stubEnv('PRACTICE_SUBMISSION_RATE_LIMIT_WINDOW_SECONDS', '600');
    expect(practiceSubmissionRateLimit()).toEqual({ max: 3, windowSeconds: 600 });
  });
  it('falls back to the default for malformed or out-of-range values, never to unlimited', () => {
    for (const bad of ['0', '-1', '1.5', 'abc', '', '1001', '1e3']) {
      vi.stubEnv('PRACTICE_SUBMISSION_RATE_LIMIT_MAX', bad);
      expect(practiceSubmissionRateLimit().max, bad).toBe(10);
    }
    vi.stubEnv('PRACTICE_SUBMISSION_RATE_LIMIT_WINDOW_SECONDS', '86401');
    expect(practiceSubmissionRateLimit().windowSeconds).toBe(3600);
    vi.stubEnv('PRACTICE_SUBMISSION_RATE_LIMIT_WINDOW_SECONDS', '0');
    expect(practiceSubmissionRateLimit().windowSeconds).toBe(3600);
  });
});
