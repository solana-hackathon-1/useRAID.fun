import { eligible, normalize, type XPost } from './domain';
import { matchedTarget } from './studio-attribution';

export const LOCKED_PHASES = ['ALLOCATED', 'HELD', 'HELD_RESOLVED'] as const;
export const isLockedPhase = (phase: string) =>
  (LOCKED_PHASES as readonly string[]).includes(phase);
export type TrackingPost = {
  id: string;
  authorId: string;
  createdAt: Date;
  text: string;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  qualification: string;
  availability: string;
  reviewStatus: string;
  hidden: boolean;
  deleted: boolean;
  enrollmentId: string | null;
};
export function qualificationReason(
  post: XPost,
  raid: {
    tag: string;
    startsAt: Date;
    endsAt: Date;
    officialHandle: string;
    ruleVersion: number;
    briefPosts?: { postId: string; createdAt: Date }[];
  },
  enrollment: { xId: string; joinedAt: Date } | null,
  tags: Set<string>,
) {
  if (!enrollment || enrollment.xId !== post.author_id) return 'NOT_ENROLLED';
  const at = Date.parse(post.created_at);
  if (!Number.isFinite(at) || at < +raid.startsAt || at >= +raid.endsAt) return 'OUTSIDE_RAID';
  if (at < +enrollment.joinedAt) return 'BEFORE_ENROLLMENT';
  if (post.referenced_tweets?.some((t) => t.type === 'retweeted')) return 'REPOST';
  if (post.referenced_tweets?.some((t) => t.type === 'replied_to')) return 'REPLY';
  if (raid.ruleVersion >= 3) {
    if (
      !post.entities?.mentions?.some(
        (mention) => mention.username.toLowerCase() === raid.officialHandle.toLowerCase(),
      )
    )
      return 'ATTRIBUTION';
  } else if (!eligible(post, raid, raid.officialHandle, tags)) return 'ATTRIBUTION';
  if (raid.ruleVersion >= 4 && !matchedTarget(post, raid.briefPosts || [])) return 'TARGET_MISSING';
  return null;
}
export function automaticRaidId(
  post: XPost,
  candidates: {
    raid: Parameters<typeof qualificationReason>[1] & { id: string };
    enrollment: { xId: string; joinedAt: Date };
  }[],
  tags: Set<string>,
) {
  const matches = candidates.filter(
    ({ raid, enrollment }) => qualificationReason(post, raid, enrollment, tags) === null,
  );
  return matches.length === 1 ? matches[0].raid.id : null;
}
export function validMetrics(post: XPost) {
  const m = post.public_metrics;
  return (
    !!m &&
    [m.like_count, m.reply_count, m.retweet_count, m.quote_count].every(
      (n) => Number.isSafeInteger(n) && n >= 0 && n <= 2147483647,
    )
  );
}
export interface TokenSet {
  count: number;
  set: Set<string>;
}
export function tokenSet(text: string): TokenSet {
  const tokens = normalize(text).split(' ').filter(Boolean);
  return { count: tokens.length, set: new Set(tokens) };
}
export function similarTokens(a: TokenSet, b: TokenSet) {
  if (a.count < 20 || b.count < 20) return false;
  let intersection = 0;
  for (const t of a.set) if (b.set.has(t)) intersection++;
  return intersection / (a.set.size + b.set.size - intersection) >= 0.9;
}
export function similarText(a: string, b: string) {
  return similarTokens(tokenSet(a), tokenSet(b));
}
export const SCORING_V3 = 3;
const SHORT_TEXT_MIN_TOKENS = 6;
export interface ShingleSet {
  count: number;
  set: Set<string>;
}
export function shingleSet(text: string): ShingleSet {
  const tokens = normalize(text).split(' ').filter(Boolean);
  const set = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    set.add(`u:${tokens[i]}`);
    if (i + 1 < tokens.length) set.add(`b:${tokens[i]} ${tokens[i + 1]}`);
  }
  return { count: tokens.length, set };
}
export function similarShingles(a: ShingleSet, b: ShingleSet) {
  if (a.count < SHORT_TEXT_MIN_TOKENS || b.count < SHORT_TEXT_MIN_TOKENS) return false;
  let intersection = 0;
  for (const t of a.set) if (b.set.has(t)) intersection++;
  return intersection / (a.set.size + b.set.size - intersection) >= 0.8;
}
export function similarTextV3(a: string, b: string) {
  return similarShingles(shingleSet(a), shingleSet(b));
}
export interface PeerPost {
  id: string;
  authorId: string;
  text: string;
  contentExpiredAt: Date | null;
}
// Peers of a post: other-author exact copies, or near copies. v2: Jaccard >= 0.9 over unique tokens
// (>= 20 tokens), which needs the unique-token counts within a factor of 0.9 of each other, so only that
// window is compared. v3: Jaccard >= 0.8 over unigrams plus bigrams (>= 6 tokens), and a post's peers are
// only the posts before it in the given (createdAt, id) order, so only later copies are flagged.
export function duplicatePeers(posts: PeerPost[], { version = 2 }: { version?: number } = {}) {
  const v3 = version >= SCORING_V3;
  const rows = posts.map((post, index) => ({
    index,
    post,
    norm: normalize(post.text),
    tokens: tokenSet(post.text),
    shingles: v3 ? shingleSet(post.text) : null,
  }));
  const live = rows.filter((r) => !r.post.contentExpiredAt);
  const byText = new Map<string, typeof rows>();
  for (const r of live) byText.set(r.norm, [...(byText.get(r.norm) || []), r]);
  const wide = (
    v3
      ? live.filter((r) => r.shingles!.count >= SHORT_TEXT_MIN_TOKENS)
      : live.filter((r) => r.tokens.count >= 20)
  ).sort((a, b) =>
    v3 ? a.shingles!.set.size - b.shingles!.set.size : a.tokens.set.size - b.tokens.set.size,
  );
  const peers = new Map<string, string[]>();
  for (const r of rows) {
    const found = new Set<string>();
    if (r.norm)
      for (const o of byText.get(r.norm) || [])
        if (
          o.post.id !== r.post.id &&
          o.post.authorId !== r.post.authorId &&
          (!v3 || o.index < r.index)
        )
          found.add(o.post.id);
    if (v3 ? r.shingles!.count >= SHORT_TEXT_MIN_TOKENS : r.tokens.count >= 20) {
      const size = v3 ? r.shingles!.set.size : r.tokens.set.size;
      const sizeOf = (o: (typeof rows)[number]) => (v3 ? o.shingles!.set.size : o.tokens.set.size);
      // Jaccard >= t needs min/max >= t, with t = 0.9 for v2 and 0.8 for v3.
      const [num, den] = v3 ? [8, 10] : [9, 10];
      let lo = 0,
        hi = wide.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sizeOf(wide[mid]) * den < size * num) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < wide.length && sizeOf(wide[i]) * num <= size * den; i++) {
        const o = wide[i];
        if (o.post.id === r.post.id || o.norm === r.norm) continue;
        if (v3) {
          if (o.index < r.index && similarShingles(r.shingles!, o.shingles!)) found.add(o.post.id);
        } else if (similarTokens(r.tokens, o.tokens)) found.add(o.post.id);
      }
    }
    peers.set(r.post.id, [...found]);
  }
  return peers;
}

export const postPoints = (
  p: Pick<TrackingPost, 'likes' | 'replies' | 'reposts' | 'quotes'>,
  version = 2,
) => {
  const engagement = Math.log2(1 + p.likes + p.replies + p.reposts + p.quotes);
  return version >= SCORING_V3 ? 100 * engagement : 100 * (1 + engagement);
};
export function scoreContributions(posts: TrackingPost[], version = 2) {
  const qualified = posts.filter(
    (p) =>
      p.enrollmentId &&
      p.qualification === 'QUALIFIED' &&
      p.availability === 'AVAILABLE' &&
      !p.hidden &&
      !p.deleted &&
      p.reviewStatus !== 'FLAGGED',
  );
  const authors = new Map<string, TrackingPost[]>();
  for (const p of qualified) authors.set(p.authorId, [...(authors.get(p.authorId) || []), p]);
  const leaderboard = [...authors]
    .map(([xId, contributions]) => {
      const best = [...contributions]
        .sort(
          (a, b) =>
            postPoints(b, version) - postPoints(a, version) ||
            +a.createdAt - +b.createdAt ||
            a.id.localeCompare(b.id),
        )
        .slice(0, 10);
      return {
        xId,
        score: Math.round(best.reduce((sum, p) => sum + postPoints(p, version), 0)),
        qualifiedPosts: contributions.length,
        scoredPostIds: best.map((p) => p.id),
      };
    })
    .filter((a) => version < SCORING_V3 || a.score > 0)
    .sort((a, b) => b.score - a.score || a.xId.localeCompare(b.xId));
  return {
    leaderboard,
    score: leaderboard.reduce((sum, a) => sum + a.score, 0),
    raiders: leaderboard.length,
    posts: qualified.length,
    interactions: qualified.reduce((sum, p) => sum + p.likes + p.replies + p.reposts + p.quotes, 0),
  };
}
