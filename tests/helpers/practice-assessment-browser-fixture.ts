import { randomUUID } from 'node:crypto';
import { seedPracticeOwnershipFixture, db } from './practice-ownership-browser-fixture';
import { runCommandTransaction } from '../../src/lib/command-receipts-adapter';
import { recordPracticeTrialOwnership } from '../../src/skills/practice-trial-ownership-storage';
import {
  issuePracticeReviewAssignment,
  revokePracticeReviewAssignment,
} from '../../src/skills/practice-review-assignment-storage';
import { publishPracticeReviewPolicy } from '../../src/skills/practice-review-policy-storage';
import {
  observePracticeTrialAssessmentContext,
  recordPracticeTrialAssessment,
  recordPracticeAssessmentDecision,
} from '../../src/skills/practice-trial-assessment-storage';
export async function seedPracticeAssessmentFixture(approved = true, expiresMs = 3600000) {
  const f = await seedPracticeOwnershipFixture(true, expiresMs);
  const issuerSession = await db.session.findFirstOrThrow({
    where: { userId: f.assignment.issuedByAccountId, via: 'x' },
  });
  const actor = { accountId: f.assignment.issuedByAccountId, sessionHash: issuerSession.tokenHash };
  const evaluator = { accountId: f.evaluatorId, sessionHash: f.sessionHash };
  const ownership = await runCommandTransaction(db, (tx) =>
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
          expectedPolicyReference: f.policy!.reference,
          expectedOwnershipReference: null,
          decision: 'CONFIRM',
          reason: 'Synthetic confirmed bounded ownership.',
          observations: [{ kind: 'EXPLANATION', detail: 'Synthetic manual explanation.' }],
        },
        idempotencyKey: randomUUID(),
        requestId: 'synthetic-confirm',
      },
      {
        allowNewWrites: true,
        canRead: () => true,
        canUsePolicy: () => true,
        canReview: () => true,
      },
    ),
  );
  const assignment = (
    await runCommandTransaction(db, (tx) =>
      issuePracticeReviewAssignment(
        tx,
        {
          actor,
          input: {
            version: 'v1',
            submissionId: f.submission.reference.recordId,
            evaluatorAccountId: f.evaluatorId,
            purpose: 'ASSESSMENT_REVIEW',
            expiresAt: new Date(Date.now() + expiresMs).toISOString(),
            reason: 'Synthetic assessment case.',
          },
          idempotencyKey: randomUUID(),
          requestId: 'synthetic-assessment-appointment',
        },
        { allowNewWrites: true, canManage: (s) => s.evaluatorAccountId === f.evaluatorId },
      ),
    )
  ).assignment;
  const policyId = 'synthetic-assessment-' + randomUUID();
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
            purpose: 'ASSESSMENT_REVIEW',
            state,
            guidance: 'Synthetic approved assessment guidance. <script>policy-inert</script>',
          },
          idempotencyKey: randomUUID(),
          requestId: 'synthetic-assessment-policy',
        },
        {
          allowNewWrites: true,
          canPublish: (s) => s.accountId === actor.accountId && s.policyId === policyId,
        },
      ),
    );
  const policy = approved ? (await publish(0, 'APPROVED')).policy : null;
  const readInput = {
    version: 'v1' as const,
    assignmentId: assignment.id,
    submissionId: f.submission.reference.recordId,
  };
  return {
    ...f,
    assignment,
    ownership: ownership.view,
    policy,
    path:
      '/evaluator/practice/' +
      assignment.id +
      '/submissions/' +
      f.submission.reference.recordId +
      '/assessment',
    withdraw: () => publish(1, 'WITHDRAWN'),
    revoke: () =>
      runCommandTransaction(db, (tx) =>
        revokePracticeReviewAssignment(
          tx,
          {
            actor,
            input: {
              version: 'v1',
              assignmentId: assignment.id,
              reason: 'Synthetic current assessment revocation.',
            },
            idempotencyKey: randomUUID(),
            requestId: 'synthetic-assessment-revoke',
          },
          { allowNewWrites: true, canManage: (s) => s.evaluatorAccountId === f.evaluatorId },
        ),
      ),
    async saveReviewOutside() {
      const refs = await runCommandTransaction(db, (tx) =>
        observePracticeTrialAssessmentContext(tx, evaluator, readInput, () => true),
      );
      if (!refs || !policy) throw Error('Fixture source missing');
      return runCommandTransaction(db, (tx) =>
        recordPracticeTrialAssessment(
          tx,
          {
            actor: evaluator,
            input: {
              ...readInput,
              expectedSubmissionReference: f.submission.reference,
              expectedDefinitionReference: f.definition.reference,
              expectedRubricReference: f.definition.rubric.reference,
              expectedPolicyReference: policy.reference,
              expectedOwnershipReference: refs.currentOwnershipReference,
              expectedReviewReference: refs.currentReviewReference,
              expectedAssessmentReference: refs.currentAssessmentReference,
              decision: 'MORE_EVIDENCE',
              reason: 'Synthetic concurrent review.',
              confidenceStatement: 'One case only.',
              criteria: f.definition.rubric.criteria.map((c) => ({
                criterionId: c.id,
                result: 'UNCERTAIN',
                reason: 'Synthetic observed criterion.',
              })),
              reassessmentAt: null,
            },
            idempotencyKey: randomUUID(),
            requestId: 'synthetic-concurrent-assessment',
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
    async revokeStateOutside() {
      const refs = await runCommandTransaction(db, (tx) =>
        observePracticeTrialAssessmentContext(tx, evaluator, readInput, () => true),
      );
      if (!refs || !policy) throw Error('Fixture source missing');
      return runCommandTransaction(db, (tx) =>
        recordPracticeAssessmentDecision(
          tx,
          {
            actor: evaluator,
            input: {
              ...readInput,
              expectedPolicyReference: policy.reference,
              expectedOwnershipReference: refs.currentOwnershipReference,
              expectedReviewReference: refs.currentReviewReference,
              expectedAssessmentReference: refs.currentAssessmentReference,
              action: 'REVOKE',
              reasonCategory: 'FRAUDULENT_ASSESSMENT_EVIDENCE',
              reason: 'Synthetic separate material evidence.',
              findings: [
                { kind: 'ASSESSMENT_EVIDENCE', detail: 'Synthetic reviewed evidence finding.' },
              ],
              dueAt: null,
            },
            idempotencyKey: randomUUID(),
            requestId: 'synthetic-concurrent-decision',
          },
          {
            allowNewWrites: true,
            canRead: () => true,
            canUsePolicy: () => true,
            canDecide: () => true,
          },
        ),
      );
    },
  };
}
export { db };
