import { db } from './db';
import { ingestTracking, markTrackingUnavailable, assertTrackingEnabled } from './tracking';
import { lookupPosts, ProviderError } from './providers/x';
import { validPostId } from './domain';
export async function processTrackingLookup(
  raidId: string,
  postId: string,
  sampleKey: string,
  submissionId?: string,
  correction = false,
) {
  assertTrackingEnabled();
  const raid = await db.raid.findUniqueOrThrow({
    where: { id: raidId },
    include: { creator: true },
  });
  if (raid.hidden || raid.creator.suspended) throw new Error('Raid collection is restricted.');
  if (['APPROVED', 'ALLOCATED', 'HELD', 'HELD_RESOLVED'].includes(raid.trackingPhase)) return;
  const invalid = async () => {
    if (submissionId)
      await db.postSubmission.updateMany({
        where: { id: submissionId, status: 'QUEUED' },
        data: { status: 'EXCLUDED', reasonCode: 'INVALID_POST' },
      });
  };
  if (!validPostId(postId)) return invalid();
  const result = await lookupPosts([postId], raidId).catch(async (error) => {
    if (submissionId && error instanceof ProviderError && error.status === 400) return null;
    throw error;
  });
  if (!result) return invalid();
  const post = result.data?.find((p) => p.id === postId);
  if (post) {
    await ingestTracking(raidId, [post], {
      sampleKey,
      submissionId,
      correction,
      source: submissionId ? 'SUBMISSION' : 'CORRECTION',
    });
    if (
      !post.public_metrics ||
      (await db.post.findUnique({ where: { id: postId } }))?.availability === 'DATA_INCOMPLETE'
    )
      throw new Error('X returned incomplete metrics.');
  } else if (
    result.errors?.some((e) => e.resource_id === postId && e.type?.endsWith('/resource-not-found'))
  ) {
    if (submissionId)
      await db.postSubmission.update({
        where: { id: submissionId },
        data: { status: 'EXCLUDED', reasonCode: 'POST_UNAVAILABLE' },
      });
    await markTrackingUnavailable(raidId, [postId], true, correction);
  } else throw new Error('X returned incomplete lookup data.');
}
