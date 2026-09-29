import type { Post } from '@prisma/client';
import { normalize } from './domain';

export function authorScores(
  posts: Post[],
  startsAt: Date,
  endsAt: Date,
  joined: Map<string, Date>,
) {
  const first = new Map<string, Post>();
  for (const post of [...posts].sort(
    (a, b) => +a.createdAt - +b.createdAt || a.id.localeCompare(b.id),
  )) {
    if (post.deleted || post.hidden) continue;
    const text = normalize(post.text);
    if (text && !first.has(text)) first.set(text, post);
  }
  const scores = new Map<string, number[]>();
  for (const post of first.values()) {
    const enrolled = joined.get(post.authorId);
    if (
      !enrolled ||
      post.createdAt < startsAt ||
      post.createdAt >= endsAt ||
      post.createdAt < enrolled
    )
      continue;
    const engagement = post.likes + post.replies + post.reposts + post.quotes;
    scores.set(post.authorId, [
      ...(scores.get(post.authorId) || []),
      1 + Math.log2(1 + engagement),
    ]);
  }
  return new Map(
    [...scores].map(([id, points]) => [
      id,
      Math.round(
        Math.min(
          20,
          points
            .sort((a, b) => b - a)
            .slice(0, 3)
            .reduce((a, b) => a + b, 0),
        ) * 100,
      ),
    ]),
  );
}
export function splitRewards(
  gross: bigint,
  claimCost: bigint,
  payoutCost: bigint,
  scores: Map<string, number>,
) {
  const net = gross - claimCost - payoutCost;
  if (net <= 0n) return null;
  const platform = net / 10n;
  const raiders = net - platform;
  const entries = [...scores]
    .filter(([, score]) => score > 0)
    .sort((a, b) => a[0].localeCompare(b[0]));
  const total = BigInt(entries.reduce((sum, [, score]) => sum + score, 0));
  if (!total) return null;
  const amounts = new Map(entries.map(([id, score]) => [id, (raiders * BigInt(score)) / total]));
  let remaining = raiders - [...amounts.values()].reduce((a, b) => a + b, 0n);
  for (const [id] of entries) {
    if (!remaining) break;
    amounts.set(id, amounts.get(id)! + 1n);
    remaining--;
  }
  return { net, platform, raiders, amounts };
}
