import { postId, type XPost } from './domain';
// Pure attribution logic: usable by tracking/tests without loading RPC or custody modules.
export function matchedTarget(post: XPost, targets: { postId: string; createdAt: Date }[]) {
  const refs = new Set(
    (post.referenced_tweets || []).filter((ref) => ref.type === 'quoted').map((ref) => ref.id),
  );
  for (const url of post.entities?.urls || []) {
    const id = postId(url.expanded_url || url.unwound_url || url.url || '');
    if (id) refs.add(id);
  }
  return (
    targets
      .filter(
        (target) => refs.has(target.postId) && +target.createdAt <= Date.parse(post.created_at),
      )
      .sort((a, b) => a.postId.localeCompare(b.postId))[0]?.postId || null
  );
}
