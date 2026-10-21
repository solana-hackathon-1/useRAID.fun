import { randomUUID } from 'node:crypto';
import { seedPracticeReviewFixture, db } from './practice-review-browser-fixture';
import { runCommandTransaction } from '../../src/lib/command-receipts-adapter';
import { issuePracticeReviewAssignment } from '../../src/skills/practice-review-assignment-storage';
export async function seedPracticeReviewInboxFixture(count = 2) {
  const f = await seedPracticeReviewFixture({ expiresMs: 8 * 3600000 });
  await db.session.update({
    where: { tokenHash: f.sessionHash },
    data: { expiresAt: new Date(Date.now() + 8 * 3600000) },
  });
  const issuer = await db.session.findFirstOrThrow({ where: { via: 'x' } });
  for (let i = 1; i < count; i++)
    await runCommandTransaction(db, (tx) =>
      issuePracticeReviewAssignment(
        tx,
        {
          actor: { accountId: issuer.userId, sessionHash: issuer.tokenHash },
          idempotencyKey: randomUUID(),
          requestId: 'synthetic-inbox-fixture',
          input: {
            version: 'v1',
            submissionId: f.assignment.submissionId,
            evaluatorAccountId: f.evaluatorId,
            purpose: i % 2 ? 'ASSESSMENT_REVIEW' : 'OWNERSHIP_REVIEW',
            reason: 'Synthetic inbox appointment only.',
            expiresAt: new Date(Date.now() + 8 * 3600000).toISOString(),
          },
        },
        { allowNewWrites: true, canManage: () => true },
      ),
    );
  return f;
}
export { db };
