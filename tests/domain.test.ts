import { describe, it, expect } from 'vitest';
import {
  eligible,
  metrics,
  momentum,
  normalize,
  postId,
  tradeUrl,
  validMint,
  type ScoringPost,
  type XPost,
} from '../src/lib/domain';
import { selectMarket } from '../src/lib/providers/market';
import { raidInput, settingsInput } from '../src/lib/validation';
const now = new Date('2026-09-27T12:00:00Z');
const post = (id: string, authorId = 'alice', likes = 0): ScoringPost => ({
  id,
  authorId,
  likes,
  replies: 0,
  reposts: 0,
  quotes: 0,
  text: `Original thought ${id}`,
  createdAt: new Date(+now - 60000),
  hidden: false,
  deleted: false,
});
describe('attention score', () => {
  it('caps the top three posts per author and author contribution', () => {
    expect(
      metrics([post('1', 'a', 7), post('2', 'a', 7), post('3', 'a', 7), post('4', 'a', 7)], now)
        .score,
    ).toBe(1200);
    expect(
      metrics([post('1', 'a', 100000), post('2', 'a', 100000), post('3', 'b', 0)], now).score,
    ).toBe(2100);
  });
  it('excludes old, future, hidden and deleted posts from score', () => {
    expect(
      metrics(
        [
          { ...post('old'), createdAt: new Date(+now - 3600000) },
          { ...post('future'), createdAt: new Date(+now + 1) },
          { ...post('hidden'), hidden: true },
          { ...post('deleted'), deleted: true },
        ],
        now,
      ).score,
    ).toBe(0);
  });
  it('deduplicates normalized content independently of arrival order', () => {
    const a = { ...post('1'), text: 'Hello world! @useRAID #raid_abc https://example.com' },
      b = { ...post('2', 'b', 100), text: 'HELLO   WORLD', createdAt: new Date(+now - 30000) };
    expect(normalize(a.text)).toBe(normalize(b.text));
    expect(metrics([b, a], now).score).toBe(100);
    expect(metrics([b, a], now).raiders).toBe(2);
  });
  it('uses latest counters even when they decrease', () => {
    expect(metrics([post('1', 'a', 3)], now).interactions).toBe(3);
    expect(metrics([post('1', 'a', 0)], now).score).toBe(100);
  });
  it('does not invent percentages with unavailable or zero baselines', () => {
    expect(momentum(100)).toBeNull();
    expect(momentum(100, { score: 0, complete: true })).toBeNull();
    expect(momentum(100, { score: 10, complete: false })).toBeNull();
    expect(momentum(50, { score: 100, complete: true })).toBe(-50);
  });
});
describe('attribution', () => {
  const raid = { tag: 'raid_abc', startsAt: new Date(+now - 3600000), endsAt: now };
  const tags = new Set(['raid_abc', 'raid_other']);
  const p: XPost = {
    id: '1',
    author_id: 'a',
    text: 'hi',
    created_at: new Date(+now - 1000).toISOString(),
    entities: { mentions: [{ username: 'UseRaid' }], hashtags: [{ tag: 'RAID_abc' }] },
  };
  it('accepts exact case-insensitive mention and tag', () =>
    expect(eligible(p, raid, 'useRAID', tags)).toBe(true));
  it('rejects wrong mention, ambiguous tags and repost wrappers', () => {
    expect(
      eligible(
        { ...p, entities: { ...p.entities, mentions: [{ username: 'notuseRAID' }] } },
        raid,
        'useRAID',
        tags,
      ),
    ).toBe(false);
    expect(
      eligible(
        {
          ...p,
          entities: { ...p.entities, hashtags: [{ tag: 'raid_abc' }, { tag: 'raid_other' }] },
        },
        raid,
        'useRAID',
        tags,
      ),
    ).toBe(false);
    expect(
      eligible(
        { ...p, referenced_tweets: [{ type: 'retweeted', id: '2' }] },
        raid,
        'useRAID',
        tags,
      ),
    ).toBe(false);
  });
  it('uses inclusive start and exclusive end boundaries', () => {
    expect(eligible({ ...p, created_at: raid.startsAt.toISOString() }, raid, 'useRAID', tags)).toBe(
      true,
    );
    expect(eligible({ ...p, created_at: now.toISOString() }, raid, 'useRAID', tags)).toBe(false);
  });
  it('accepts qualifying replies and quotes', () =>
    expect(
      eligible({ ...p, referenced_tweets: [{ type: 'quoted', id: '2' }] }, raid, 'useRAID', tags),
    ).toBe(true));
});
describe('identity and external URLs', () => {
  const mint = 'So11111111111111111111111111111111111111112';
  it('validates a decoded 32-byte mint', () => {
    expect(validMint(mint)).toBe(true);
    expect(validMint('abc')).toBe(false);
    expect(validMint('0'.repeat(44))).toBe(false);
    expect(tradeUrl(mint)).toContain(mint);
  });
  it('does not accept arbitrary submitted URLs', () => {
    expect(postId('https://x.com/alice/status/123')).toBe('123');
    expect(postId('https://x.com.evil.test/alice/status/123')).toBeNull();
    expect(postId('http://x.com/alice/status/123')).toBeNull();
    expect(postId('https://x.com/alice/status/123/evil')).toBeNull();
  });
  it('selects highest liquidity correct-chain base mint without inventing market cap', () => {
    const base = {
      chainId: 'solana',
      baseToken: { address: mint, symbol: 'SOL', name: 'Solana' },
      pairAddress: 'a',
      url: 'https://invalid',
      dexId: 'test',
      liquidity: { usd: 1 },
      fdv: 100,
    };
    const selected = selectMarket(
      [
        base,
        { ...base, pairAddress: 'b', liquidity: { usd: 20 } },
        { ...base, chainId: 'ethereum', liquidity: { usd: 10000 } },
      ],
      mint,
    );
    expect(selected?.pairAddress).toBe('b');
    expect(selected?.marketCap).toBeNull();
    expect(selected?.fdv).toBe(100);
    expect(selected?.url).toBe('https://dexscreener.com/solana/b');
  });
  it('enforces duration and spend limits', () => {
    expect(
      raidInput.safeParse({
        title: 'hello',
        description: 'a'.repeat(25),
        mint,
        symbol: 'SOL',
        name: 'Solana',
        duration: 73,
      }).success,
    ).toBe(false);
    expect(
      settingsInput.safeParse({
        collectionEnabled: true,
        maxActiveRaids: 10,
        maxCreators: 5,
        monthlyBudgetCents: 20000,
        cutoffCents: 20000,
        dailyRequestLimit: 5000,
      }).success,
    ).toBe(false);
  });
});
