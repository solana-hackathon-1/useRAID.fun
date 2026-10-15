import { readPracticeTrialForReview } from '../skills/practice-review-read-storage';
import type { SkillTaxonomyActor } from '../skills/taxonomy-storage';
import { runCommandTransaction } from './command-receipts-adapter';
import { db } from './db';
export function practiceReviewReadConfiguration() {
  const readsAvailable = process.env.PRACTICE_REVIEW_READS_ENABLED === 'true';
  return { readsAvailable, unavailableReason: readsAvailable ? null : ('DISABLED' as const) };
}
export async function readPracticeTrialForReviewFromHost(
  actor: SkillTaxonomyActor,
  input: unknown,
) {
  const review = await runCommandTransaction(db, (tx) =>
    readPracticeTrialForReview(
      tx,
      actor,
      input,
      () => practiceReviewReadConfiguration().readsAvailable,
    ),
  );
  const config = practiceReviewReadConfiguration();
  return { version: 'v1' as const, review: config.readsAvailable ? review : null, ...config };
}
