import {
  issuePracticeReviewAssignment,
  revokePracticeReviewAssignment,
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
