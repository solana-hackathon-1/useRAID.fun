import bs58 from 'bs58';
export interface XPost {
  id: string;
  author_id: string;
  text: string;
  created_at: string;
  entities?: {
    mentions?: { username: string }[];
    hashtags?: { tag: string }[];
    urls?: { expanded_url?: string; unwound_url?: string; url?: string }[];
  };
  referenced_tweets?: { type: string; id: string }[];
  public_metrics?: {
    like_count: number;
    reply_count: number;
    retweet_count: number;
    quote_count: number;
    impression_count?: number;
  };
}
export interface ScoringPost {
  id: string;
  authorId: string;
  text: string;
  createdAt: Date;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  hidden: boolean;
  deleted: boolean;
}
export const interactions = (p: Pick<ScoringPost, 'likes' | 'replies' | 'reposts' | 'quotes'>) =>
  p.likes + p.replies + p.reposts + p.quotes;
export function normalize(text: string) {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/@\w+|#raid_\w+/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
export function validMint(value: string) {
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}
export function eligible(
  post: XPost,
  raid: { tag: string; startsAt: Date; endsAt: Date },
  handle: string,
  tags: Set<string>,
) {
  const at = new Date(post.created_at).getTime();
  const hashtags = new Set((post.entities?.hashtags || []).map((t) => t.tag.toLowerCase()));
  return Boolean(
    post.author_id &&
    Number.isFinite(at) &&
    at >= +raid.startsAt &&
    at < +raid.endsAt &&
    post.entities?.mentions?.some((m) => m.username.toLowerCase() === handle.toLowerCase()) &&
    hashtags.has(raid.tag.toLowerCase()) &&
    [...hashtags].filter((t) => tags.has(t)).length === 1 &&
    !post.referenced_tweets?.some((t) => t.type === 'retweeted'),
  );
}
export function metrics(posts: ScoringPost[], now: Date) {
  const visible = posts.filter((p) => !p.hidden && !p.deleted && +p.createdAt <= +now);
  const unique = new Map<string, ScoringPost>();
  for (const p of [...visible].sort(
    (a, b) => +a.createdAt - +b.createdAt || a.id.localeCompare(b.id),
  )) {
    const text = normalize(p.text);
    if (text && !unique.has(text)) unique.set(text, p);
  }
  const authors = new Map<string, number[]>();
  for (const p of unique.values())
    if (+p.createdAt > +now - 3600000) {
      const points = 1 + Math.log2(1 + interactions(p));
      authors.set(p.authorId, [...(authors.get(p.authorId) || []), points]);
    }
  const score = Math.round(
    [...authors.values()].reduce(
      (sum, points) =>
        sum +
        Math.min(
          20,
          points
            .sort((a, b) => b - a)
            .slice(0, 3)
            .reduce((a, b) => a + b, 0),
        ),
      0,
    ) * 100,
  );
  return {
    score,
    raiders: new Set(visible.map((p) => p.authorId)).size,
    posts: visible.length,
    interactions: visible.reduce((a, p) => a + interactions(p), 0),
  };
}
export function momentum(score: number, baseline?: { score: number; complete: boolean } | null) {
  return baseline?.complete && baseline.score > 0
    ? Math.round(((score - baseline.score) / baseline.score) * 100)
    : null;
}
export function validPostId(id: string) {
  return /^[1-9]\d{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n;
}
export function postId(url: string) {
  try {
    const u = new URL(url);
    if (
      !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(u.hostname) ||
      u.protocol !== 'https:'
    )
      return null;
    const id = u.pathname.match(/^\/(?:[A-Za-z0-9_]+|i\/web)\/status\/(\d+)\/?$/)?.[1];
    return id && validPostId(id) ? id : null;
  } catch {
    return null;
  }
}
export function tradeUrl(mint: string) {
  if (!validMint(mint)) throw new Error('Invalid mint');
  const input = mint === 'So11111111111111111111111111111111111111112' ? 'USDC' : 'SOL';
  return `https://jup.ag/swap/${input}-${encodeURIComponent(mint)}`;
}
export function composeUrl(handle: string, tag: string, ruleVersion = 1, targetPostId?: string) {
  const u = new URL('https://x.com/intent/post');
  u.searchParams.set(
    'text',
    ruleVersion >= 4 && targetPostId
      ? `@${handle}\n\nhttps://x.com/i/web/status/${targetPostId}`
      : ruleVersion >= 3
        ? `@${handle}\n\n`
        : `@${handle} #${tag}\n\n`,
  );
  return u.toString();
}
