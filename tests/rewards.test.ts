import { describe, expect, it } from 'vitest';
import { authorScores, splitRewards } from '../src/lib/reward-math';
import type { Post } from '@prisma/client';
const at = (value: string) => new Date(`2026-09-28T${value}Z`);
function post(id: string, authorId: string, time: string, text: string, likes = 0): Post {
  return {
    id,
    raidId: 'raid',
    authorId,
    text,
    normalized: text.toLowerCase(),
    contentHash: null,
    targetPostId: null,
    createdAt: at(time),
    observedAt: at('12:10:00'),
    likes,
    replies: 0,
    reposts: 0,
    quotes: 0,
    views: null,
    hidden: false,
    deleted: false,
    enrollmentId: null,
    source: 'SEARCH',
    postType: 'ORIGINAL',
    qualification: 'LEGACY',
    reasonCode: null,
    ruleVersion: 1,
    availability: 'AVAILABLE',
    reviewStatus: 'CLEAR',
    reviewFingerprint: null,
    adminExcluded: false,
    contentExpiredAt: null,
    lastObservationId: null,
  };
}
describe('hourly reward scoring', () => {
  it('uses verified enrollment time, interval bounds, duplicate filter, and three-post cap', () => {
    const joined = new Map([
      ['alice', at('10:10:00')],
      ['bob', at('10:00:00')],
    ]);
    const posts = [
      post('1', 'alice', '10:05:00', 'before joining'),
      post('2', 'alice', '10:11:00', 'Original one', 2),
      post('3', 'alice', '10:12:00', 'Original one', 99),
      post('4', 'alice', '10:13:00', 'Original two', 3),
      post('5', 'alice', '10:14:00', 'Original three', 4),
      post('6', 'alice', '10:15:00', 'Original four', 99),
      post('7', 'bob', '10:16:00', 'Original one', 99),
      post('8', 'bob', '11:00:00', 'new hour', 10),
    ];
    const scores = authorScores(posts, at('10:00:00'), at('11:00:00'), joined);
    expect(scores.has('bob')).toBe(false);
    expect(scores.get('alice')).toBeGreaterThan(0);
    expect(scores.get('alice')).toBeLessThanOrEqual(2000);
    expect(
      authorScores(
        [post('1', 'alice', '10:10:00', 'hidden')],
        at('10:00:00'),
        at('11:00:00'),
        joined,
      ).get('alice'),
    ).toBe(100);
  });
});
describe('fee split', () => {
  it('subtracts network costs once and conserves every lamport', () => {
    const split = splitRewards(
      1_000_003n,
      10_000n,
      20_000n,
      new Map([
        ['alice', 100],
        ['bob', 200],
      ]),
    )!;
    expect(split.net).toBe(970_003n);
    expect(split.platform).toBe(97_000n);
    expect(split.raiders).toBe(873_003n);
    expect([...split.amounts.values()].reduce((a, b) => a + b, 0n)).toBe(split.raiders);
    expect(split.amounts.get('bob')).toBeGreaterThan(split.amounts.get('alice')!);
  });
  it('holds funds when costs exceed claims or no eligible score exists', () => {
    expect(splitRewards(10n, 10n, 0n, new Map([['alice', 100]]))).toBeNull();
    expect(splitRewards(100n, 0n, 0n, new Map())).toBeNull();
  });
});
