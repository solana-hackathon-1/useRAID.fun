import { db } from './db';
import { ingestTracking, markTrackingUnavailable, assertTrackingEnabled } from './tracking';
import { lookupOutcome, lookupPosts, ProviderError } from './providers/x';
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
  } else {
    const outcome = lookupOutcome(result.errors, postId);
    if (outcome === 'unknown') throw new Error('X returned incomplete lookup data.');
    const reasonCode = outcome === 'restricted' ? 'POST_RESTRICTED' : 'POST_UNAVAILABLE';
    if (submissionId)
      await db.postSubmission.update({
        where: { id: submissionId },
        data: { status: 'EXCLUDED', reasonCode },
      });
    await markTrackingUnavailable(raidId, [postId], true, correction, reasonCode);
  }
}
