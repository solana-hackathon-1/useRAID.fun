import {
  recordPracticeTrialOwnership,
  readPracticeTrialOwnership,
  type PracticeTrialOwnershipCommand,
} from '../skills/practice-trial-ownership-storage';
import type { SkillTaxonomyActor } from '../skills/taxonomy-storage';
import { runCommandTransaction } from './command-receipts-adapter';
import { practiceReviewReadConfiguration } from './practice-review-reads-host';
import { db } from './db';
export function practiceTrialOwnershipWriteConfiguration() {
  const writesAvailable = process.env.PRACTICE_TRIAL_OWNERSHIP_ENABLED === 'true';
  return { writesAvailable, unavailableReason: writesAvailable ? null : ('DISABLED' as const) };
}
export async function recordPracticeTrialOwnershipFromHost(command: PracticeTrialOwnershipCommand) {
  const r = await runCommandTransaction(db, (tx) =>
    recordPracticeTrialOwnership(tx, command, {
      allowNewWrites: practiceTrialOwnershipWriteConfiguration().writesAvailable,
      canRead: () => practiceReviewReadConfiguration().readsAvailable,
      canUsePolicy: () => practiceReviewReadConfiguration().readsAvailable,
      canReview: () =>
        practiceTrialOwnershipWriteConfiguration().writesAvailable &&
        practiceReviewReadConfiguration().readsAvailable,
    }),
  );
  const reads = practiceReviewReadConfiguration();
  return {
    version: 'v1' as const,
    ...r,
    view: reads.readsAvailable ? r.view : null,
    readsAvailable: reads.readsAvailable,
    ...practiceTrialOwnershipWriteConfiguration(),
  };
}
export async function readPracticeTrialOwnershipFromHost(
  actor: SkillTaxonomyActor,
  input: unknown,
) {
  const view = await runCommandTransaction(db, (tx) =>
    readPracticeTrialOwnership(
      tx,
      actor,
      input,
      () => practiceReviewReadConfiguration().readsAvailable,
    ),
  );
  const config = practiceReviewReadConfiguration();
  return { version: 'v1' as const, view: config.readsAvailable ? view : null, ...config };
}
