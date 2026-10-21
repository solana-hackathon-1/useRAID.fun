import { randomUUID } from 'node:crypto';
import { seedPracticeReviewFixture, db } from './practice-review-browser-fixture';
import { publishPracticeReviewPolicy } from '../../src/skills/practice-review-policy-storage';
import { recordPracticeTrialOwnership } from '../../src/skills/practice-trial-ownership-storage';
import { runCommandTransaction } from '../../src/lib/command-receipts-adapter';
export async function seedPracticeOwnershipFixture(approved = true, expiresMs = 3600000) {
  const f = await seedPracticeReviewFixture({ expiresMs });
  const session = await db.session.findFirstOrThrow({
    where: { userId: f.assignment.issuedByAccountId, via: 'x' },
  });
  const actor = { accountId: f.assignment.issuedByAccountId, sessionHash: session.tokenHash };
  const evaluator = { accountId: f.evaluatorId, sessionHash: f.sessionHash };
  const policyId = 'synthetic-ownership-' + randomUUID();
  const publish = (expectedRevision: number, state: 'APPROVED' | 'WITHDRAWN') =>
    runCommandTransaction(db, (tx) =>
      publishPracticeReviewPolicy(
        tx,
        {
          actor,
          input: {
            version: 'v1',
            policyId,
            expectedRevision,
            definitionReference: f.definition.reference,
            purpose: 'OWNERSHIP_REVIEW',
            state,
            guidance: 'Synthetic approved ownership guidance. <script>policy-inert</script>',
          },
          idempotencyKey: randomUUID(),
          requestId: 'synthetic-browser-policy',
        },
        {
          allowNewWrites: true,
          canPublish: (s) => s.accountId === actor.accountId && s.policyId === policyId,
        },
      ),
    );
  const policy = approved ? (await publish(0, 'APPROVED')).policy : null;
  return {
    ...f,
    path: f.path.split('?')[0] + '/ownership',
    policy,
    withdraw: () => publish(1, 'WITHDRAWN'),
    async saveOutsideBrowser(
      expectedOwnershipReference: { recordId: string; revision: number } | null = null,
    ) {
      if (!policy) throw Error('Synthetic policy required');
      return runCommandTransaction(db, (tx) =>
        recordPracticeTrialOwnership(
          tx,
          {
            actor: evaluator,
            input: {
              version: 'v1',
              assignmentId: f.assignment.id,
              submissionId: f.submission.reference.recordId,
              expectedSubmissionReference: f.submission.reference,
              expectedDefinitionReference: f.definition.reference,
              expectedRubricReference: f.definition.rubric.reference,
              expectedPolicyReference: policy.reference,
              expectedOwnershipReference,
              decision: 'MORE_EVIDENCE',
              reason: 'Synthetic concurrent finding.',
              observations: [{ kind: 'OTHER', detail: 'Synthetic concurrent observation.' }],
            },
            idempotencyKey: randomUUID(),
            requestId: 'synthetic-concurrent-finding',
          },
          {
            allowNewWrites: true,
            canRead: () => true,
            canUsePolicy: () => true,
            canReview: () => true,
          },
        ),
      );
    },
  };
}
export { db };
