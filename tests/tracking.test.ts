import { describe, it, expect } from 'vitest';
import {
  automaticRaidId,
  duplicatePeers,
  qualificationReason,
  scoreContributions,
  similarText,
  similarTextV3,
  postPoints,
  validMetrics,
  type TrackingPost,
} from '../src/lib/tracking-domain';
import { normalize, type XPost } from '../src/lib/domain';
import { lookupOutcome, searchQuery } from '../src/lib/providers/x';
const raid = {
  id: 'legacy-raid',
  tag: 'raid_test',
  ruleVersion: 2,
  officialHandle: 'useRAID',
  startsAt: new Date('2026-09-29T10:00:00Z'),
  endsAt: new Date('2026-09-29T12:00:00Z'),
};
const member = { xId: 'alice', joinedAt: new Date('2026-09-29T10:30:00Z') };
const candidate: XPost = {
  id: '1',
  author_id: 'alice',
  text: 'Original @useRAID #raid_test',
  created_at: '2026-09-29T11:00:00Z',
  entities: { mentions: [{ username: 'useRAID' }], hashtags: [{ tag: 'raid_test' }] },
  public_metrics: { like_count: 4, reply_count: 1, retweet_count: 2, quote_count: 0 },
};
const qualify = (patch: Partial<XPost>) =>
  qualificationReason(
    { ...candidate, ...patch },
    raid,
    member,
    new Set(['raid_test', 'raid_other']),
  );
const post = (id: string, likes = 0): TrackingPost => ({
  id,
  authorId: 'alice',
  createdAt: new Date('2026-09-29T11:00:00Z'),
  text: id,
  likes,
  replies: 0,
  reposts: 0,
  quotes: 0,
  qualification: 'QUALIFIED',
  availability: 'AVAILABLE',
  reviewStatus: 'CLEAR',
  hidden: false,
  deleted: false,
  enrollmentId: 'member',
});
describe('tracking v2 rules', () => {
  it('checks enrollment, immutable author, and inclusive start/exclusive end', () => {
    expect(qualify({})).toBeNull();
    expect(qualify({ author_id: 'bob' })).toBe('NOT_ENROLLED');
    expect(qualify({ created_at: '2026-09-29T10:29:59Z' })).toBe('BEFORE_ENROLLMENT');
    expect(qualify({ created_at: member.joinedAt.toISOString() })).toBeNull();
    expect(qualify({ created_at: raid.endsAt.toISOString() })).toBe('OUTSIDE_RAID');
    expect(qualify({ created_at: 'invalid' })).toBe('OUTSIDE_RAID');
  });
  it('allows originals/quotes and excludes replies/reposts', () => {
    expect(qualify({ referenced_tweets: [{ type: 'quoted', id: '2' }] })).toBeNull();
    expect(qualify({ referenced_tweets: [{ type: 'replied_to', id: '2' }] })).toBe('REPLY');
    expect(qualify({ referenced_tweets: [{ type: 'retweeted', id: '2' }] })).toBe('REPOST');
    expect(qualify({ entities: { hashtags: [{ tag: 'raid_test' }] } })).toBe('ATTRIBUTION');
    expect(
      qualify({
        entities: {
          ...candidate.entities,
          hashtags: [{ tag: 'raid_test' }, { tag: 'raid_other' }],
        },
      }),
    ).toBe('ATTRIBUTION');
  });
  it('requires only the own-text mention under rule 3 and preserves old hashtag rules', () => {
    const mentionOnly = {
      ...candidate,
      text: 'Original @useRAID',
      entities: { mentions: [{ username: 'useRAID' }] },
    };
    expect(
      qualificationReason(mentionOnly, { ...raid, ruleVersion: 3 }, member, new Set()),
    ).toBeNull();
    expect(qualificationReason(mentionOnly, raid, member, new Set())).toBe('ATTRIBUTION');
    expect(
      qualificationReason(
        { ...mentionOnly, entities: { hashtags: [{ tag: 'raid_test' }] } },
        { ...raid, ruleVersion: 3 },
        member,
        new Set(),
      ),
    ).toBe('ATTRIBUTION');
    expect(
      qualificationReason(
        { ...mentionOnly, referenced_tweets: [{ type: 'quoted', id: '9' }] },
        { ...raid, ruleVersion: 3 },
        member,
        new Set(),
      ),
    ).toBeNull();
    expect(
      qualificationReason(
        { ...mentionOnly, referenced_tweets: [{ type: 'replied_to', id: '9' }] },
        { ...raid, ruleVersion: 3 },
        member,
        new Set(),
      ),
    ).toBe('REPLY');
    expect(
      qualificationReason(
        { ...mentionOnly, referenced_tweets: [{ type: 'retweeted', id: '9' }] },
        { ...raid, ruleVersion: 3 },
        member,
        new Set(),
      ),
    ).toBe('REPOST');
  });
  it('assigns automatic mentions only with one eligible enrollment at creation', () => {
    const newRaid = { ...raid, id: 'new-raid', ruleVersion: 3 };
    const candidates = [{ raid: newRaid, enrollment: member }];
    const mentionOnly = { ...candidate, entities: { mentions: [{ username: 'useRAID' }] } };
    expect(automaticRaidId(mentionOnly, candidates, new Set())).toBe('new-raid');
    expect(
      automaticRaidId(
        mentionOnly,
        [...candidates, { raid: { ...newRaid, id: 'other-raid' }, enrollment: member }],
        new Set(),
      ),
    ).toBeNull();
    expect(
      automaticRaidId(
        mentionOnly,
        [{ raid: newRaid, enrollment: { ...member, joinedAt: new Date('2026-09-29T11:01:00Z') } }],
        new Set(),
      ),
    ).toBeNull();
  });
  it('does not invent zero metrics from partial or malformed observations', () => {
    expect(validMetrics(candidate)).toBe(true);
    expect(validMetrics({ ...candidate, public_metrics: undefined })).toBe(false);
    expect(
      validMetrics({
        ...candidate,
        public_metrics: { ...candidate.public_metrics!, like_count: -1 },
      }),
    ).toBe(false);
  });
  it('scores best ten across the whole Raid with deterministic ties and one rounding', () => {
    const posts = Array.from({ length: 12 }, (_, i) =>
      post(String(i).padStart(2, '0'), i < 2 ? 0 : 2),
    );
    const score = scoreContributions(posts);
    expect(score.leaderboard[0].scoredPostIds).toEqual(posts.slice(2).map((p) => p.id));
    expect(score.score).toBe(Math.round(10 * 100 * (1 + Math.log2(3))));
    expect(scoreContributions([...posts].reverse())).toEqual(score);
    expect(scoreContributions([post('2'), post('1')]).leaderboard[0].scoredPostIds).toEqual([
      '1',
      '2',
    ]);
  });
  it('keeps incomplete, flagged, excluded, hidden, and unverified records out of scoring', () => {
    expect(
      scoreContributions([
        { ...post('1'), qualification: 'EXCLUDED' },
        { ...post('2'), availability: 'DATA_INCOMPLETE' },
        { ...post('3'), reviewStatus: 'FLAGGED' },
        { ...post('4'), hidden: true },
        { ...post('5'), enrollmentId: null },
      ]).score,
    ).toBe(0);
  });
  it('flags near copies only at the versioned threshold and minimum length', () => {
    const text = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ');
    expect(similarText(text, text.replace('word19', 'changed'))).toBe(true);
    expect(
      similarText(text, text.replace('word19', 'changed').replace('word18', 'different')),
    ).toBe(false);
    expect(similarText('short repeated text', 'short repeated text')).toBe(false);
  });
  it('scores v3 zero-engagement posts at 0 and keeps v2 unchanged', () => {
    const none = { likes: 0, replies: 0, reposts: 0, quotes: 0 };
    expect(postPoints(none, 3)).toBe(0);
    expect(postPoints(none, 2)).toBe(100);
    expect(postPoints(none)).toBe(100);
    expect(postPoints({ ...none, likes: 3 }, 3)).toBe(200);
    const posts = [
      post('1', 0),
      { ...post('2', 0), authorId: 'bob' },
      { ...post('3', 3), authorId: 'cara' },
    ];
    expect(scoreContributions(posts, 3).leaderboard.map((a) => a.xId)).toEqual(['cara']);
    expect(scoreContributions(posts, 3).score).toBe(200);
    expect(scoreContributions(posts, 2).leaderboard).toHaveLength(3);
    expect(scoreContributions(posts).score).toBe(100 + 100 + 300);
  });
  it('detects short near-duplicates only for v3 and only from six tokens', () => {
    const text = 'gm raiders loving the new useRAID campaign launch today friends';
    const changed = text.replace('friends', 'frens');
    expect(similarTextV3(text, changed)).toBe(true);
    expect(similarText(text, changed)).toBe(false);
    expect(
      similarTextV3(text, 'completely unrelated words about something else entirely here'),
    ).toBe(false);
    expect(similarTextV3('gm raiders loving it', 'gm raiders loving this')).toBe(false);
  });
  it('flags only the later copy under v3 and both under v2', () => {
    const base = { contentExpiredAt: null, text: 'same words for both raiders in this raid' };
    const posts = [
      { id: '1', authorId: 'a', ...base },
      { id: '2', authorId: 'b', ...base },
      { id: '3', authorId: 'c', ...base, text: base.text + ' now' },
    ];
    expect([...duplicatePeers(posts, { version: 3 }).entries()]).toEqual([
      ['1', []],
      ['2', ['1']],
      ['3', expect.arrayContaining(['1', '2'])],
    ]);
    expect(duplicatePeers(posts, { version: 2 }).get('1')).toEqual(['2']);
  });
  it('classifies lookup errors per post', () => {
    const e = (type: string, id = '9') => [{ resource_id: id, type }];
    const base = 'https://api.twitter.com/2/problems/';
    expect(lookupOutcome(e(`${base}resource-not-found`), '9')).toBe('missing');
    expect(lookupOutcome(e(`${base}not-authorized-for-resource`), '9')).toBe('restricted');
    expect(lookupOutcome(e(`${base}resource-unavailable`), '9')).toBe('restricted');
    expect(lookupOutcome(e(`${base}client-forbidden`), '9')).toBe('unknown');
    expect(lookupOutcome(e(`${base}resource-not-found`, '8'), '9')).toBe('unknown');
    expect(lookupOutcome(undefined, '9')).toBe('unknown');
  });
  it.each([2, 3])('finds the same duplicate peers as the quadratic reference (v%i)', (version) => {
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const vocab = Array.from({ length: 40 }, (_, i) => `w${i}`);
    const bases = Array.from({ length: 6 }, () =>
      Array.from({ length: 18 + Math.floor(rand() * 14) }, () => vocab[Math.floor(rand() * 40)]),
    );
    const posts = Array.from({ length: 200 }, (_, i) => {
      const words = [...bases[Math.floor(rand() * bases.length)]];
      if (rand() < 0.5) words[Math.floor(rand() * words.length)] = `x${i}`;
      if (rand() < 0.3) words.push(vocab[Math.floor(rand() * 40)]);
      if (rand() < 0.1) words.length = Math.min(words.length, 10);
      return {
        id: String(1000 + i),
        authorId: `a${Math.floor(rand() * 20)}`,
        text: words.join(' '),
        contentExpiredAt: rand() < 0.05 ? new Date() : null,
      };
    });
    const similar = version === 3 ? similarTextV3 : similarText;
    const naive = (p: (typeof posts)[number]) => {
      const text = normalize(p.text);
      return posts
        .filter(
          (o) =>
            o.id !== p.id &&
            !o.contentExpiredAt &&
            (version < 3 || posts.indexOf(o) < posts.indexOf(p)) &&
            ((o.authorId !== p.authorId && text && normalize(o.text) === text) ||
              (normalize(o.text) !== text && similar(p.text, o.text))),
        )
        .map((o) => o.id)
        .sort();
    };
    const fast = duplicatePeers(posts, { version });
    let related = 0;
    for (const p of posts) {
      const expected = naive(p);
      related += expected.length;
      expect([...fast.get(p.id)!].sort()).toEqual(expected);
    }
    expect(related).toBeGreaterThan(50);
  });
});
describe('raid-specific search query', () => {
  const v2 = { tag: 'raid_test', trackingVersion: 2, officialHandle: 'useRAID' };
  it('filters rule 3+ mentions to the enrolled authors, sorted by id', () => {
    const query = searchQuery({ ...v2, ruleVersion: 3 }, ['20', '10']);
    expect(query).toBe('@useRAID -is:retweet -is:reply (from:10 OR from:20)');
  });
  it('keeps the tag query for rule 2 and legacy raids', () => {
    expect(searchQuery({ ...v2, ruleVersion: 2 }, ['10'])).toBe('@useRAID #raid_test -is:retweet');
    expect(searchQuery({ tag: 'raid_test' }, null)).toMatch(/#raid_test -is:retweet$/);
  });
  it('falls back to the unfiltered query when the author list exceeds the limit', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `19000000000000000${i + 10}`);
    expect(searchQuery({ ...v2, ruleVersion: 3 }, ids)).toBe('@useRAID -is:retweet -is:reply');
  });
});
