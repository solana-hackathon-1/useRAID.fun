import { randomUUID, randomBytes } from 'node:crypto';
import { seedPracticePortalFixture, db } from './practice-portal-fixture';
import { hash } from '../../src/lib/auth-primitives';
import { runCommandTransaction } from '../../src/lib/command-receipts-adapter';
import { readPracticeTrialStart } from '../../src/skills/practice-trial-attempt-storage';
import { submitPracticeTrial } from '../../src/skills/practice-trial-submission-storage';
import {
  issuePracticeReviewAssignment,
  revokePracticeReviewAssignment,
} from '../../src/skills/practice-review-assignment-storage';
import { assertTestDatabase } from './db-guard';
export const reviewAnswer =
  '\n  <script>window.__review_injected = true</script>\r\n<img src="/should-not-fetch-review-fixture">review-private-answer-marker';
export async function seedPracticeReviewFixture(
  options: { purpose?: 'OWNERSHIP_REVIEW' | 'ASSESSMENT_REVIEW'; expiresMs?: number } = {},
) {
  assertTestDatabase();
  const learner = await seedPracticePortalFixture();
  const subject = { accountId: learner.ownerId, sessionHash: learner.cookieHash };
  const startId = await learner.startOutsideBrowser();
  const start = await runCommandTransaction(db, (tx) =>
    readPracticeTrialStart(tx, subject, startId),
  );
  if (!start) throw new Error('Synthetic start missing');
  const submitted = await runCommandTransaction(db, (tx) =>
    submitPracticeTrial(
      tx,
      {
        actor: subject,
        idempotencyKey: randomUUID(),
        requestId: 'synthetic-review-submission',
        input: {
          version: 'v1',
          startId,
          expectedDefinitionReference: start.definition.reference,
          expectedRubricReference: start.definition.rubric.reference,
          answer: reviewAnswer,
          explanation: 'review-private-explanation-marker',
          toolsUsed: ['editor'],
          aiAssistanceUsed: true,
          assistanceDisclosure: 'review-private-disclosure-marker',
        },
      },
      { allowNewWrites: true },
    ),
  );
  const evaluator = await db.user.create({
    data: { handle: 'synthetic-reviewer', role: 'CREATOR' },
  });
  const cookie = randomBytes(32).toString('base64url'),
    sessionHash = hash(cookie);
  await db.session.create({
    data: {
      tokenHash: sessionHash,
      userId: evaluator.id,
      via: 'wallet',
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  const issuer = await db.user.create({
    data: { handle: 'synthetic-issuer', role: 'ADMIN', xId: randomUUID() },
  });
  const issuerHash = hash(randomUUID());
  await db.session.create({
    data: {
      tokenHash: issuerHash,
      userId: issuer.id,
      via: 'x',
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  const actor = { accountId: issuer.id, sessionHash: issuerHash };
  const purpose = options.purpose ?? 'OWNERSHIP_REVIEW';
  const input = {
    version: 'v1',
    submissionId: submitted.submission.reference.recordId,
    evaluatorAccountId: evaluator.id,
    purpose,
    expiresAt: new Date(Date.now() + (options.expiresMs ?? 3600000)).toISOString(),
    reason: 'Synthetic evaluator browser case only.',
  };
  const canManage = (scope: { evaluatorAccountId: string; subjectAccountId: string }) =>
    scope.evaluatorAccountId === evaluator.id && scope.subjectAccountId === subject.accountId;
  const { assignment } = await runCommandTransaction(db, (tx) =>
    issuePracticeReviewAssignment(
      tx,
      {
        actor,
        input,
        idempotencyKey: randomUUID(),
        requestId: 'synthetic-review-assignment',
      },
      { allowNewWrites: true, canManage },
    ),
  );
  const path =
    '/evaluator/practice/' +
    assignment.id +
    '/submissions/' +
    input.submissionId +
    '?purpose=' +
    purpose;
  return {
    cookie,
    sessionHash,
    evaluatorId: evaluator.id,
    path,
    assignment,
    definition: start.definition,
    submission: submitted.submission,
    async revoke() {
      await runCommandTransaction(db, (tx) =>
        revokePracticeReviewAssignment(
          tx,
          {
            actor,
            input: {
              version: 'v1',
              assignmentId: assignment.id,
              reason: 'Synthetic browser revocation.',
            },
            idempotencyKey: randomUUID(),
            requestId: 'synthetic-review-revoke',
          },
          { allowNewWrites: true, canManage },
        ),
      );
    },
    async signOut() {
      await db.session.deleteMany({ where: { tokenHash: sessionHash } });
    },
  };
}
export { db };
