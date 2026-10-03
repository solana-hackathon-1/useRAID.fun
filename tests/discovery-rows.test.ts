import { describe, it, expect } from 'vitest';
import { discoveryRows } from '../src/lib/discovery-rows';
import type { RaidView } from '../src/lib/types';

const now = Date.parse('2026-09-27T12:00:00Z');
const raid = (id: string, score: number, lastPostMinutesAgo: number | null): RaidView =>
  ({
    id,
    status: 'ACTIVE',
    symbol: id.toUpperCase(),
    name: id,
    title: id,
    mint: `mint-${id}`,
    createdAt: new Date(now - 7200000).toISOString(),
    score,
    raiders: 1,
    delta: 0,
    freshness: 'fresh',
    activity:
      lastPostMinutesAgo === null
        ? []
        : [
            {
              id: `p-${id}`,
              authorId: 'a',
              text: 't',
              createdAt: new Date(now - lastPostMinutesAgo * 60000).toISOString(),
              interactions: 0,
            },
          ],
  }) as unknown as RaidView;

describe('discovery tabs', () => {
  const raids = [
    raid('big', 900, 50),
    raid('fresh', 10, 2),
    raid('quiet', 500, null),
    raid('stale', 800, 90),
  ];
  it('Live shows only raids with a post in the last hour, newest first', () => {
    expect(discoveryRows(raids, 'Live', '', false, now).map((r) => r.id)).toEqual(['fresh', 'big']);
  });
  it('Trending still ranks every active raid by score', () => {
    expect(discoveryRows(raids, 'Trending', '', false, now).map((r) => r.id)).toEqual([
      'big',
      'stale',
      'quiet',
      'fresh',
    ]);
  });
  it('Live moves on as time passes', () => {
    expect(discoveryRows(raids, 'Live', '', false, now + 3600000).map((r) => r.id)).toEqual([]);
  });
  it('applies search on top of Live', () => {
    expect(discoveryRows(raids, 'Live', 'BIG', false, now).map((r) => r.id)).toEqual(['big']);
  });
});
