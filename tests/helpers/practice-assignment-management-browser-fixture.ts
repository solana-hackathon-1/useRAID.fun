import { randomBytes } from 'node:crypto';
import { seedPracticeReviewFixture, db } from './practice-review-browser-fixture';
import { hash } from '../../src/lib/auth-primitives';
import { runCommandTransaction } from '../../src/lib/command-receipts-adapter';
import { revokePracticeReviewAssignment } from '../../src/skills/practice-review-assignment-storage';
export const managementAdminXId = 'synthetic-management-admin-x';
export async function seedPracticeAssignmentManagementFixture() {
  const f = await seedPracticeReviewFixture({ expiresMs: 8 * 3600000 });
  const managerId = f.assignment.issuedByAccountId;
  await db.user.update({
    where: { id: managerId },
    data: { xId: managementAdminXId, handle: 'synthetic-management-admin' },
  });
  const managerCookie = randomBytes(32).toString('base64url'),
    sessionHash = hash(managerCookie);
  await db.session.create({
    data: {
      tokenHash: sessionHash,
      userId: managerId,
      via: 'x',
      expiresAt: new Date(Date.now() + 8 * 3600000),
    },
  });
  const actor = { accountId: managerId, sessionHash };
  return {
    ...f,
    managerId,
    managerCookie,
    managerSessionHash: sessionHash,
    path: '/admin/practice/review-assignments?submissionId=' + f.assignment.submissionId,
    async revokeOutsideBrowser(assignmentId: string) {
      return runCommandTransaction(db, (tx) =>
        revokePracticeReviewAssignment(
          tx,
          {
            actor,
            input: { version: 'v1', assignmentId, reason: 'Synthetic external correction.' },
            idempotencyKey: crypto.randomUUID(),
            requestId: 'synthetic-manager-revoke',
          },
          { allowNewWrites: true, canManage: () => true },
        ),
      );
    },
    async signOutManager() {
      await db.session.deleteMany({ where: { tokenHash: sessionHash } });
    },
  };
}
export { db };
