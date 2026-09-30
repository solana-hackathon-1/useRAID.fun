import { db } from './db';
import { lookupPosts } from './providers/x';
import { postId } from './domain';
export { matchedTarget } from './studio-attribution';
import { HttpError } from './auth-primitives';
import { studioSandbox } from './usdc';
export type TargetPreview = {
  id: string;
  text: string;
  authorId: string;
  handle: string;
  checkedAt: string;
};
export async function targetPreviews(ids: string[], raidId?: string): Promise<TargetPreview[]> {
  if (!ids.length) return [];
  if (studioSandbox())
    return ids.map((id) => ({
      id,
      text: 'A new idea deserves a community. Help us share this launch and tell people why it matters.',
      authorId: 'sandbox-project',
      handle: 'project',
      checkedAt: new Date().toISOString(),
    }));
  const response = await lookupPosts(ids, raidId);
  return (response.data || []).map((post) => ({
    id: post.id,
    text: post.text,
    authorId: post.author_id,
    handle: response.includes?.users?.find((u) => u.id === post.author_id)?.username || '',
    checkedAt: new Date().toISOString(),
  }));
}
export function targetIds(urls: string[]) {
  const ids = urls.map((url) => postId(url));
  if (ids.some((id) => !id)) throw new HttpError(400, 'Enter a public X post URL.');
  if (new Set(ids).size !== ids.length)
    throw new HttpError(400, 'This target post is already added.');
  return ids as string[];
}
export async function addStudioTarget(raidId: string, userId: string, url: string) {
  const id = targetIds([url])[0];
  const raid = await db.raid.findUnique({ where: { id: raidId } });
  if (!raid || raid.creatorId !== userId || raid.hidden)
    throw new HttpError(404, 'Raid not found.');
  const preview = (await targetPreviews([id], raidId))[0];
  if (!preview) throw new HttpError(400, 'Target post is unavailable. Choose another public post.');
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(729103)`;
    const current = await tx.raid.findUniqueOrThrow({
      where: { id: raidId },
      include: { creator: true },
    });
    if (
      current.creator.suspended ||
      current.hidden ||
      !['DRAFT', 'ACTIVE'].includes(current.status) ||
      (current.status === 'ACTIVE' && current.endsAt <= new Date())
    )
      throw new HttpError(409, 'This Raid is not accepting target posts.');
    if ((await tx.raidBriefPost.count({ where: { raidId } })) >= 100)
      throw new HttpError(409, 'Maximum 100 target posts.');
    return tx.raidBriefPost.upsert({
      where: { raidId_postId: { raidId, postId: id } },
      create: { raidId, postId: id, preview, validatedAt: new Date() },
      update: {},
    });
  });
}
