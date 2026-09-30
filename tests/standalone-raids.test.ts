import { describe, expect, it } from 'vitest';
import { fundingQuote } from '../src/lib/raid-funding';
import { observedImpressions } from '../src/lib/raid-progress';
import { splitImpressionFunding } from '../src/lib/raid-allocation';

describe('standalone Raid funding', () => {
  it('quotes integer lamports and rejects impossible targets', () => {
    expect(fundingQuote(1500, 10000000)).toBe('15000000');
    expect(() => fundingQuote(0, 10000000)).toThrow();
    expect(() => fundingQuote(1000, 0)).toThrow();
  });
  it('never counts excluded, flagged, or unavailable posts toward target', () => {
    const post = {
      views: 600,
      qualification: 'QUALIFIED',
      availability: 'AVAILABLE',
      reviewStatus: 'CLEAR',
      hidden: false,
      deleted: false,
    };
    expect(
      observedImpressions([
        post,
        { ...post, views: 400 },
        { ...post, views: 9000, qualification: 'EXCLUDED' },
        { ...post, views: 9000, reviewStatus: 'FLAGGED' },
        { ...post, views: null },
      ]),
    ).toEqual({ total: 1000, missing: 1 });
    expect(
      observedImpressions(
        Array.from({ length: 5 }, () => ({ ...post, views: Number.MAX_SAFE_INTEGER })),
      ),
    ).toEqual({ total: Number.MAX_SAFE_INTEGER, missing: 0 });
  });
  it('splits earned funding by verified views and refunds unearned balance', () => {
    const members = [
      { xId: 'a', walletAddress: 'wallet-a', views: 600 },
      { xId: 'b', walletAddress: 'wallet-b', views: 400 },
    ];
    const partial = splitImpressionFunding(1_000_000_000n, 2000, members);
    expect(partial.rewards.map((r) => r.lamports)).toEqual([300_000_000n, 200_000_000n]);
    expect(partial.refund).toBe(500_000_000n);
    const full = splitImpressionFunding(1_000_000_000n, 1000, members);
    expect(full.rewards.map((r) => r.lamports)).toEqual([600_000_000n, 400_000_000n]);
    expect(full.refund).toBe(0n);
    expect(splitImpressionFunding(1_000_000_000n, 1000, []).refund).toBe(1_000_000_000n);
  });
});
