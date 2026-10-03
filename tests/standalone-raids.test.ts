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
  describe('per-author cap and minimum payout', () => {
    const author = (xId: string, views: number) => ({ xId, walletAddress: `wallet-${xId}`, views });
    const pool = 1_000_000_000n;
    it('caps a dominant author and redistributes the excess pro rata, capping again if needed', () => {
      const split = splitImpressionFunding(
        pool,
        1000,
        [author('a', 900), author('b', 50), author('c', 50)],
        { capBps: 2500 },
      );
      expect(split.rewards.map((r) => r.lamports)).toEqual([
        250_000_000n,
        250_000_000n,
        250_000_000n,
      ]);
      expect(split.refund).toBe(250_000_000n);
    });
    it('redistributes capped excess to uncapped authors', () => {
      const split = splitImpressionFunding(
        pool,
        1000,
        [author('a', 600), author('b', 200), author('c', 100), author('d', 100)],
        { capBps: 4000 },
      );
      expect(split.rewards.map((r) => r.lamports)).toEqual([
        400_000_000n,
        300_000_000n,
        150_000_000n,
        150_000_000n,
      ]);
      expect(split.rewards.reduce((sum, r) => sum + r.lamports, 0n) + split.refund).toBe(pool);
    });
    it('pays a lone author at most the cap and refunds the rest', () => {
      const split = splitImpressionFunding(pool, 1000, [author('a', 1000)], { capBps: 2500 });
      expect(split.rewards.map((r) => r.lamports)).toEqual([250_000_000n]);
      expect(split.refund).toBe(750_000_000n);
    });
    it('splits four equal authors exactly at the cap', () => {
      const split = splitImpressionFunding(
        pool,
        1000,
        ['a', 'b', 'c', 'd'].map((x) => author(x, 250)),
        { capBps: 2500 },
      );
      expect(split.rewards.map((r) => r.lamports)).toEqual(Array(4).fill(250_000_000n));
      expect(split.refund).toBe(0n);
    });
    it('cascades the cap through several authors', () => {
      const split = splitImpressionFunding(
        pool,
        1000,
        [author('a', 600), author('b', 300), author('c', 50), author('d', 50)],
        { capBps: 2500 },
      );
      expect(split.rewards.map((r) => r.lamports)).toEqual(Array(4).fill(250_000_000n));
    });
    it('conserves every unit and never exceeds the cap across random inputs', () => {
      let seed = 12345;
      const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
      for (let round = 0; round < 500; round++) {
        const budget = BigInt(1 + (next() % 1_000_000_000));
        const count = 1 + (next() % 8);
        const results = Array.from({ length: count }, (_, i) => author(`x${i}`, next() % 2000));
        const capBps = 1 + (next() % 10000);
        const minPayout = BigInt(next() % 5000);
        const target = 1 + (next() % 4000);
        const split = splitImpressionFunding(budget, target, results, { capBps, minPayout });
        const cap = (budget * BigInt(capBps)) / 10000n;
        const all = [...split.rewards, ...split.belowMinimum];
        expect(all.reduce((sum, r) => sum + r.lamports, 0n) + split.refund).toBe(budget);
        expect(split.refund >= 0n).toBe(true);
        for (const r of all) {
          expect(r.lamports > 0n && r.lamports <= cap).toBe(true);
        }
        for (const r of split.rewards) expect(r.lamports >= minPayout).toBe(true);
        for (const r of split.belowMinimum) expect(r.lamports < minPayout).toBe(true);
        for (const a of all)
          for (const b of all) if (a.views >= b.views) expect(a.lamports >= b.lamports).toBe(true);
      }
    });
    it('moves rewards below the minimum into belowMinimum without losing funds', () => {
      const split = splitImpressionFunding(
        1_000_000_000n,
        1_000_000,
        [author('a', 999_000), author('b', 500)],
        { minPayout: 890_880n },
      );
      expect(split.rewards.map((r) => r.xId)).toEqual(['a']);
      expect(split.belowMinimum.map((r) => [r.xId, r.lamports])).toEqual([['b', 500_000n]]);
      expect(split.rewards[0].lamports + split.belowMinimum[0].lamports + split.refund).toBe(
        1_000_000_000n,
      );
    });
    it('rejects an invalid cap', () => {
      expect(() => splitImpressionFunding(pool, 1000, [], { capBps: 0 })).toThrow();
      expect(() => splitImpressionFunding(pool, 1000, [], { capBps: 10001 })).toThrow();
    });
  });
});
