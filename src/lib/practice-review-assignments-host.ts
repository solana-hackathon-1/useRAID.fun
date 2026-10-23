import {
  issuePracticeReviewAssignment,
  revokePracticeReviewAssignment,
  readPracticeAssignmentManagement,
  PracticeReviewAssignmentError,
  type PracticeReviewAssignmentCommand,
} from '../skills/practice-review-assignment-storage';
import { adminXIds } from './admins';
import { runCommandTransaction } from './command-receipts-adapter';
import { db } from './db';
export function practiceReviewAssignmentWriteConfiguration() {
  const writesAvailable = process.env.PRACTICE_REVIEW_ASSIGNMENTS_ENABLED === 'true';
  return { writesAvailable, unavailableReason: writesAvailable ? null : ('DISABLED' as const) };
}
export async function issuePracticeReviewAssignmentFromHost(
  command: PracticeReviewAssignmentCommand,
) {
  const result = await runCommandTransaction(db, (tx) =>
    issuePracticeReviewAssignment(tx, command, {
      allowNewWrites: practiceReviewAssignmentWriteConfiguration().writesAvailable,
      canManage: ({ xId }) => adminXIds().includes(xId),
    }),
  );
  return { version: 'v1' as const, ...result, ...practiceReviewAssignmentWriteConfiguration() };
}
export async function revokePracticeReviewAssignmentFromHost(
  command: PracticeReviewAssignmentCommand,
) {
  const result = await runCommandTransaction(db, (tx) =>
    revokePracticeReviewAssignment(tx, command, {
      allowNewWrites: practiceReviewAssignmentWriteConfiguration().writesAvailable,
      canManage: ({ xId }) => adminXIds().includes(xId),
    }),
  );
  return { version: 'v1' as const, ...result, ...practiceReviewAssignmentWriteConfiguration() };
}

/** Reads remain available to actual authorized managers when new appointment writes are off. */
export async function readPracticeAssignmentManagementFromHost(
  actor: import('../skills/taxonomy-storage-contracts').SkillTaxonomyActor,
  input: unknown,
) {
  const result = await runCommandTransaction(db, (tx) =>
    readPracticeAssignmentManagement(tx, actor, input, {
      canInspect: ({ xId }) => adminXIds().includes(xId),
      canManage: ({ xId }) => adminXIds().includes(xId),
    }),
  );
  if (!adminXIds().includes(result.managerXId))
    throw new PracticeReviewAssignmentError('FORBIDDEN');
  return { version: 'v1' as const, ...practiceReviewAssignmentWriteConfiguration(), result };
}
