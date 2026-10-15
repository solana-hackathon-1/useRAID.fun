import {
  publishPracticeReviewPolicy,
  observeApprovedPracticeReviewPolicy,
  readPracticeReviewPolicyAsAdmin,
  lockApprovedPracticeReviewPolicy,
  type PublishPracticeReviewPolicyCommand,
} from '../skills/practice-review-policy-storage';
import type { SkillTaxonomyActor } from '../skills/taxonomy-storage';
import { adminXIds } from './admins';
import { runCommandTransaction } from './command-receipts-adapter';
import { practiceReviewReadConfiguration } from './practice-review-reads-host';
import { db } from './db';
export function practiceReviewPolicyWriteConfiguration() {
  const writesAvailable = process.env.PRACTICE_REVIEW_POLICY_PUBLICATION_ENABLED === 'true';
  return { writesAvailable, unavailableReason: writesAvailable ? null : ('DISABLED' as const) };
}
export async function publishPracticeReviewPolicyFromHost(
  command: PublishPracticeReviewPolicyCommand,
) {
  const result = await runCommandTransaction(db, (tx) =>
    publishPracticeReviewPolicy(tx, command, {
      allowNewWrites: practiceReviewPolicyWriteConfiguration().writesAvailable,
      canPublish: ({ xId }) => adminXIds().includes(xId),
    }),
  );
  return { version: 'v1' as const, ...result, ...practiceReviewPolicyWriteConfiguration() };
}
export async function readPracticeReviewPolicyAsAdminFromHost(
  actor: SkillTaxonomyActor,
  id: string,
  revision?: number,
) {
  const view = await runCommandTransaction(db, (tx) =>
    readPracticeReviewPolicyAsAdmin(tx, actor, id, revision, ({ xId }) =>
      adminXIds().includes(xId),
    ),
  );
  return { version: 'v1' as const, view };
}
export async function readApprovedPracticeReviewPolicyFromHost(
  actor: SkillTaxonomyActor,
  input: unknown,
) {
  const view = await runCommandTransaction(db, (tx) =>
    lockApprovedPracticeReviewPolicy(
      tx,
      actor,
      input,
      () => practiceReviewReadConfiguration().readsAvailable,
    ),
  );
  const config = practiceReviewReadConfiguration();
  return { version: 'v1' as const, view: config.readsAvailable ? view : null, ...config };
}

export async function observeApprovedPracticeReviewPolicyFromHost(
  actor: SkillTaxonomyActor,
  input: unknown,
) {
  const view = await runCommandTransaction(db, (tx) =>
    observeApprovedPracticeReviewPolicy(
      tx,
      actor,
      input,
      () => practiceReviewReadConfiguration().readsAvailable,
    ),
  );
  const config = practiceReviewReadConfiguration();
  return { version: 'v1' as const, view: config.readsAvailable ? view : null, ...config };
}
