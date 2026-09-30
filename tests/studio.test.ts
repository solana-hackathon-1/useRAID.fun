import { describe, it, expect, vi } from 'vitest';
import { quoteUsdc, units, formatUsdc } from '../src/lib/usdc-amount';
import { matchedTarget, targetIds } from '../src/lib/studio-targets';
import { qualificationReason } from '../src/lib/tracking-domain';
import { studioSandbox } from '../src/lib/usdc';
import { config } from '../src/lib/config';
import { composeUrl } from '../src/lib/domain';
const at = new Date('2026-09-30T10:00:00Z');
const target = { postId: '123456789', createdAt: at };
const post = {
  id: '987654321',
  author_id: 'author',
  text: 'My own thought @useRAID',
  created_at: '2026-09-30T10:01:00Z',
  entities: { mentions: [{ username: 'useRAID' }] },
  referenced_tweets: [{ type: 'quoted' as const, id: target.postId }],
};
describe('Studio amounts and target attribution', () => {
  it('uses six-decimal USDC, ceil quotes, and rejects malformed amounts', () => {
    expect(units('12.000001')).toBe(12000001n);
    expect(formatUsdc(12000001n)).toBe('12.000001');
    expect(quoteUsdc(1001, 1n)).toBe(2n);
    for (const invalid of ['0', '-1', '1e6', 'NaN', '1.0000001'])
      expect(() => units(invalid)).toThrow();
    expect(() => quoteUsdc(999, 1n)).toThrow();
  });
  it('matches selected quotes or expanded links, never retroactive targets', () => {
    expect(
      new URL(composeUrl('useRAID', 'raid', 4, target.postId)).searchParams.get('text'),
    ).toContain(`https://x.com/i/web/status/${target.postId}`);
    expect(matchedTarget(post, [target])).toBe(target.postId);
    expect(
      matchedTarget(
        {
          ...post,
          referenced_tweets: [],
          entities: { urls: [{ expanded_url: `https://x.com/project/status/${target.postId}` }] },
        },
        [target],
      ),
    ).toBe(target.postId);
    expect(
      matchedTarget(post, [{ ...target, createdAt: new Date('2026-09-30T10:02:00Z') }]),
    ).toBeNull();
    expect(() =>
      targetIds([
        `https://x.com/p/status/${target.postId}`,
        `https://twitter.com/p/status/${target.postId}`,
      ]),
    ).toThrow();
  });
  it('requires membership, own-author, mention, selected target and posting window', () => {
    const raid = {
      tag: 'raid_test',
      startsAt: at,
      endsAt: new Date(+at + 3600000),
      officialHandle: 'useRAID',
      ruleVersion: 4,
      briefPosts: [target],
    };
    const member = { xId: 'author', joinedAt: at };
    expect(qualificationReason(post, raid, member, new Set())).toBeNull();
    expect(qualificationReason(post, raid, { ...member, xId: 'wrong' }, new Set())).toBe(
      'NOT_ENROLLED',
    );
    expect(qualificationReason({ ...post, referenced_tweets: [] }, raid, member, new Set())).toBe(
      'TARGET_MISSING',
    );
    expect(qualificationReason({ ...post, entities: {} }, raid, member, new Set())).toBe(
      'ATTRIBUTION',
    );
  });
  it('requires all sandbox guards; production can never enable fixture funding', () => {
    const original = config.appUrl;
    config.appUrl = 'http://localhost:3007';
    vi.stubEnv('STUDIO_SANDBOX', 'true');
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost/useraid_studio_test');
    vi.stubEnv('NODE_ENV', 'development');
    expect(studioSandbox()).toBe(true);
    vi.stubEnv('NODE_ENV', 'production');
    expect(studioSandbox()).toBe(false);
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost/useraid');
    expect(studioSandbox()).toBe(false);
    vi.unstubAllEnvs();
    config.appUrl = original;
  });
});
