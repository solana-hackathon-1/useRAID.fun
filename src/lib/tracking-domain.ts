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
export function similarText(a: string, b: string) {
  const at = normalize(a).split(' ').filter(Boolean),
    bt = normalize(b).split(' ').filter(Boolean);
  if (at.length < 20 || bt.length < 20) return false;
  const x = new Set(at),
    y = new Set(bt);
  const intersection = [...x].filter((t) => y.has(t)).length;
  return intersection / new Set([...x, ...y]).size >= 0.9;
}
export const postPoints = (p: Pick<TrackingPost, 'likes' | 'replies' | 'reposts' | 'quotes'>) =>
  100 * (1 + Math.log2(1 + p.likes + p.replies + p.reposts + p.quotes));
export function scoreContributions(posts: TrackingPost[]) {
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
            postPoints(b) - postPoints(a) ||
            +a.createdAt - +b.createdAt ||
            a.id.localeCompare(b.id),
        )
        .slice(0, 10);
      return {
        xId,
        score: Math.round(best.reduce((sum, p) => sum + postPoints(p), 0)),
        qualifiedPosts: contributions.length,
        scoredPostIds: best.map((p) => p.id),
      };
    })
    .sort((a, b) => b.score - a.score || a.xId.localeCompare(b.xId));
  return {
    leaderboard,
    score: leaderboard.reduce((sum, a) => sum + a.score, 0),
    raiders: leaderboard.length,
    posts: qualified.length,
    interactions: qualified.reduce((sum, p) => sum + p.likes + p.replies + p.reposts + p.quotes, 0),
  };
}
