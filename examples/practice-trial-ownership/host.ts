import {
  recordPracticeTrialOwnership,
  readPracticeTrialOwnership,
  type PracticeTrialOwnershipScope,
} from './skills/practice-trial-ownership-storage';
import {
  publishPracticeReviewPolicy,
  readPracticeReviewPolicyAsAdmin,
  lockApprovedPracticeReviewPolicy,
  observeApprovedPracticeReviewPolicy,
  type PracticeReviewPolicyScope,
} from './skills/practice-review-policy-storage';
import { readPracticeTrialForReview } from './skills/practice-review-read-storage';
import {
  issuePracticeReviewAssignment,
  revokePracticeReviewAssignment,
  lockPracticeReviewAssignment,
  type PracticeReviewAssignmentScope,
} from './skills/practice-review-assignment-storage';
import {
  submitPracticeTrial,
  readPracticeTrialSubmission,
} from './skills/practice-trial-submission-storage';
import {
  startPracticeTrial,
  readPracticeTrialStart,
} from './skills/practice-trial-attempt-storage';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { pool } from './connection';
import {
  retryWholeTransaction,
  CommandReceiptError,
  type CommandReceiptTransaction,
} from './command-receipts';
import { publishSkillTaxonomy } from './skills/taxonomy-storage';
import {
  publishPracticeTrialDefinition,
  readPracticeTrialDefinition,
} from './skills/practice-trial-storage';
async function transaction<T>(work: (tx: CommandReceiptTransaction) => Promise<T>): Promise<T> {
  return retryWholeTransaction(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query("SET LOCAL statement_timeout='5s'");
      await client.query("SET LOCAL lock_timeout='2s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout='5s'");
      const [statementBound] = (
        await client.query<{ statement_timeout: string }>('SHOW statement_timeout')
      ).rows;
      const [lockBound] = (await client.query<{ lock_timeout: string }>('SHOW lock_timeout')).rows;
      assert.equal(statementBound.statement_timeout, '5s');
      assert.equal(lockBound.lock_timeout, '2s');
      const port: CommandReceiptTransaction = {
        dialect: 'POSTGRESQL',
        isolation: 'READ_COMMITTED',
        async query<Row>(sql: string, bindings: readonly (string | null)[]) {
          try {
            return (await client.query<Row>(sql, bindings)).rows;
          } catch (error) {
            const state = (error as { code?: string }).code;
            throw new CommandReceiptError(
              state === '40001' || state === '40P01' ? 'RETRY_TRANSACTION' : 'STORAGE_UNAVAILABLE',
            );
          }
        },
      };
      const result = await work(port);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
}

const accountId = 'synthetic-admin-' + randomUUID(),
  xId = 'synthetic-x-' + randomUUID();
const actor = { accountId, sessionHash: createHash('sha256').update(randomUUID()).digest('hex') };
const allowed = new Set([xId]);
const setPolicy = ({ xId }: { xId: string }) => allowed.has(xId);
const alternatePolicy = ({ xId }: { xId: string }) => Array.from(allowed).includes(xId);
const catalogId = 'synthetic-catalog-' + randomUUID(),
  trialId = 'synthetic-trial-' + randomUUID();
const draft = {
  version: 'v1',
  purpose: 'UNPAID_PLATFORM_PRACTICE',
  skillId: 'frontend',
  skillDomain: 'web',
  targetRank: 'A',
  title: 'Synthetic interface practice',
  brief: 'Build and explain a synthetic accessible interface.',
  variantId: 'synthetic-one',
  inputs: [
    { label: 'Fixture', material: 'SYNTHETIC', content: 'Invented public test records only.' },
  ],
  tools: {
    permitted: ['editor', 'browser'],
    aiAssistance: 'ALLOWED',
    disclosure: 'Disclose assistance and explain or modify the solution.',
  },
  expectedMinutes: 60,
  rubric: {
    reference: { recordId: 'synthetic-rubric-' + randomUUID(), revision: 1 },
    criteria: [
      { id: 'behavior', description: 'Relevant behavior, tests and edge cases.', required: true },
      { id: 'ownership', description: 'Explain and modify the solution.', required: true },
    ],
  },
  evaluatorMethod: 'MANUAL',
  passConditions: 'Apply every required criterion under the approved manual rubric.',
  maximumAttempts: 2,
  cooldownSeconds: 0,
  accommodationPolicy: 'Request a scoped approved accommodation.',
};
const input = {
  trialId,
  expectedRevision: 0,
  taxonomyReference: { recordId: catalogId, revision: 1 },
  availability: 'AVAILABLE',
  draft,
};
const key = randomUUID();
const save = (
  body: unknown = input,
  idempotencyKey = key,
  enabled = true,
  canPublish = setPolicy,
) =>
  transaction((tx) =>
    publishPracticeTrialDefinition(
      tx,
      { actor, input: body, idempotencyKey, requestId: 'synthetic-request' },
      { allowNewWrites: enabled, canPublish },
    ),
  );
try {
  const client = await pool.connect();
  try {
    await client.query(`INSERT INTO "User"("id","role","xId") VALUES($1,'ADMIN',$2)`, [
      accountId,
      xId,
    ]);
    await client.query(
      `INSERT INTO "Session"("tokenHash","userId","via","expiresAt") VALUES($1,$2,'x',(clock_timestamp() AT TIME ZONE 'UTC')+interval '10 minutes')`,
      [actor.sessionHash, accountId],
    );
  } finally {
    client.release();
  }
  await transaction((tx) =>
    publishSkillTaxonomy(
      tx,
      {
        actor,
        input: {
          taxonomyId: catalogId,
          expectedRevision: 0,
          skills: [
            {
              id: 'frontend',
              domain: 'web',
              name: 'Frontend',
              status: 'ACTIVE',
              aliases: ['frontend'],
            },
          ],
        },
        idempotencyKey: randomUUID(),
        requestId: 'synthetic-catalog',
      },
      { allowNewWrites: true, canPublish: setPolicy },
    ),
  );
  const learner = {
    accountId: 'synthetic-human-' + randomUUID(),
    sessionHash: createHash('sha256').update(randomUUID()).digest('hex'),
  };
  let learnerParticipantId = '';
  const fixtureClient = await pool.connect();
  try {
    await fixtureClient.query(
      `INSERT INTO "User"("id","role","xId","suspended") VALUES($1,'CREATOR',NULL,false)`,
      [learner.accountId],
    );
    await fixtureClient.query(
      `INSERT INTO "Session"("tokenHash","userId","via","expiresAt") VALUES($1,$2,'wallet',(clock_timestamp() AT TIME ZONE 'UTC')+interval '10 minutes')`,
      [learner.sessionHash, learner.accountId],
    );
    const [mapped] = (
      await fixtureClient.query<{ id: string }>(
        `INSERT INTO "Participant"("accountId","provisionActorAccountId","provisionRequestId") VALUES($1,$1,'synthetic-provision') RETURNING "id"::text`,
        [learner.accountId],
      )
    ).rows;
    assert(mapped);
    learnerParticipantId = mapped.id;
  } finally {
    fixtureClient.release();
  }
  const startInput = {
      version: 'v1',
      definitionReference: { recordId: trialId, revision: 1 },
      accommodationReference: null,
    },
    startKey = randomUUID();
  const begin = (enabled = true, key = startKey) =>
    transaction((tx) =>
      startPracticeTrial(
        tx,
        { actor: learner, input: startInput, idempotencyKey: key, requestId: 'synthetic-start' },
        { allowNewWrites: enabled },
      ),
    );
  const first = await save();
  assert.equal(first.status, 'EXECUTED');
  assert.equal(first.trial.definition.reference.revision, 1);
  assert.equal(first.trial.verifiesSkill, false);
  assert.equal(first.trial.consumesCapacity, false);
  assert.equal(first.trial.createsFinancialObligation, false);
  const started = await begin();
  assert.equal(started.start.participantId, learnerParticipantId);
  assert.equal(started.start.attemptNumber, 1);
  assert.equal(started.start.persisted, true);
  assert.equal(started.start.verifiesSkill, false);
  assert.equal(started.start.consumesCapacity, false);
  const secondStart = await begin(true, randomUUID());
  await assert.rejects(() => begin(true, randomUUID()), /ATTEMPT_LIMIT_REACHED/);
  const submissionInput = {
    version: 'v1',
    startId: started.start.id,
    expectedDefinitionReference: started.start.definition.reference,
    expectedRubricReference: started.start.definition.rubric.reference,
    answer: '\n  const synthetic = "literal code";\r\n',
    explanation: 'I can explain and modify this invented response.',
    toolsUsed: ['editor'],
    aiAssistanceUsed: false,
    assistanceDisclosure: 'No AI assistance declared.',
  };
  const submissionKey = randomUUID();
  const submit = (body: unknown = submissionInput, key = submissionKey, enabled = true) =>
    transaction((tx) =>
      submitPracticeTrial(
        tx,
        { actor: learner, input: body, idempotencyKey: key, requestId: 'synthetic-submit' },
        { allowNewWrites: enabled },
      ),
    );
  const submitted = await submit();
  assert.equal(submitted.submission.answer, submissionInput.answer);
  assert.equal(submitted.submission.ownership, 'UNCONFIRMED');
  assert.equal(submitted.submission.verifiesSkill, false);
  await assert.rejects(
    () => submit({ ...submissionInput, answer: submissionInput.answer + ' ' }),
    /IDEMPOTENCY_KEY_REUSED/,
  );
  await assert.rejects(() => submit(submissionInput, randomUUID()), /ALREADY_SUBMITTED/);
  const retired = await save(
    { ...input, expectedRevision: 1, availability: 'RETIRED' },
    randomUUID(),
  );
  assert.equal(retired.trial.availability, 'RETIRED');
  const replay = await save(input, key, false, alternatePolicy);
  assert.equal(replay.status, 'REPLAYED');
  assert.deepEqual(replay.trial, first.trial);
  assert.deepEqual(
    await transaction((tx) => readPracticeTrialDefinition(tx, actor, trialId, 1)),
    first.trial,
  );
  const changed = {
    ...input,
    expectedRevision: 2,
    draft: {
      ...draft,
      rubric: {
        ...draft.rubric,
        criteria: [
          {
            ...draft.rubric.criteria[0],
            description: 'Cannot change this immutable rubric version.',
          },
        ],
      },
    },
  };
  await assert.rejects(() => save(changed, randomUUID()), /RUBRIC_CONFLICT/);
  const afterRetirement = await submit(
    {
      ...submissionInput,
      startId: secondStart.start.id,
      answer: 'A second invented response after retirement.',
    },
    randomUUID(),
  );
  assert.equal(afterRetirement.submission.startId, secondStart.start.id);
  const originalSubmission = await submit(submissionInput, submissionKey, false);
  assert.equal(originalSubmission.status, 'REPLAYED');
  assert.deepEqual(originalSubmission.submission, submitted.submission);
  assert.deepEqual(
    await transaction((tx) =>
      readPracticeTrialSubmission(tx, learner, submitted.submission.reference.recordId),
    ),
    submitted.submission,
  );
  const privateClient = await pool.connect();
  try {
    const [row] = (
      await privateClient.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM "PracticeTrialSubmission"`,
      )
    ).rows;
    assert.equal(row.count, 2);
  } finally {
    privateClient.release();
  }
  const originalStart = await begin(false);
  assert.equal(originalStart.status, 'REPLAYED');
  assert.deepEqual(originalStart.start, started.start);
  assert.deepEqual(
    await transaction((tx) => readPracticeTrialStart(tx, learner, started.start.id)),
    started.start,
  );
  const evaluator = {
    accountId: 'synthetic-reviewer-' + randomUUID(),
    sessionHash: createHash('sha256').update(randomUUID()).digest('hex'),
  };
  const reviewerFixture = await pool.connect();
  try {
    await reviewerFixture.query(
      `INSERT INTO "User"("id","role","xId","suspended") VALUES($1,'CREATOR',NULL,false)`,
      [evaluator.accountId],
    );
    await reviewerFixture.query(
      `INSERT INTO "Session"("tokenHash","userId","via","expiresAt") VALUES($1,$2,'wallet',(clock_timestamp() AT TIME ZONE 'UTC')+interval '10 minutes')`,
      [evaluator.sessionHash, evaluator.accountId],
    );
  } finally {
    reviewerFixture.release();
  }
  const appointmentInput = {
    version: 'v1',
    submissionId: submitted.submission.reference.recordId,
    evaluatorAccountId: evaluator.accountId,
    purpose: 'OWNERSHIP_REVIEW',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    reason: 'Synthetic explicit review assignment.',
  };
  const appointmentKey = randomUUID();
  const scopedPolicy = (scope: PracticeReviewAssignmentScope) =>
    setPolicy(scope) &&
    scope.subjectAccountId === learner.accountId &&
    scope.evaluatorAccountId === evaluator.accountId &&
    scope.skillId === 'frontend' &&
    scope.purpose === 'OWNERSHIP_REVIEW' &&
    scope.expiresAt === appointmentInput.expiresAt;
  const assign = (enabled = true) =>
    transaction((tx) =>
      issuePracticeReviewAssignment(
        tx,
        {
          actor,
          input: appointmentInput,
          idempotencyKey: appointmentKey,
          requestId: 'synthetic-assign',
        },
        { allowNewWrites: enabled, canManage: scopedPolicy },
      ),
    );
  const assignment = (await assign()).assignment;
  const reviewScope = {
    assignmentId: assignment.id,
    submissionId: appointmentInput.submissionId,
    purpose: 'OWNERSHIP_REVIEW' as const,
  };
  const reviewInput = { version: 'v1', ...reviewScope };
  const beforeRead = await transaction((tx) =>
    tx.query<{ receipts: number; audits: number; outbox: number }>(
      'SELECT (SELECT count(*)::int FROM "CommandReceipt") receipts,(SELECT count(*)::int FROM "AuditEvent") audits,(SELECT count(*)::int FROM "OutboxEvent") outbox',
      [],
    ),
  );
  const review = await transaction((tx) =>
    readPracticeTrialForReview(
      {
        ...tx,
        async query<Row>(sql: string, bindings: readonly (string | null)[]) {
          if (sql.includes('"answer"')) {
            const events = await tx.query<{ actorId: string; payload: unknown }>(
              `SELECT "actorId","payload" FROM "AuditEvent" WHERE "eventType"='skill.practice_review_access_authorized.v1'`,
              [],
            );
            assert.equal(events.length, 1);
            assert.equal(events[0].actorId, evaluator.accountId);
            assert.deepEqual(events[0].payload, { practiceReviewAssignmentId: assignment.id });
          }
          return tx.query<Row>(sql, bindings);
        },
      },
      evaluator,
      reviewInput,
      (scope) =>
        scope.subjectAccountId === learner.accountId &&
        scope.purpose === 'OWNERSHIP_REVIEW' &&
        scope.expiresAt === appointmentInput.expiresAt,
    ),
  );
  assert(review?.private);
  assert.match(review.accessId, /^[a-f0-9-]{36}$/);
  assert.equal(review.isAuthorizationToken, false);
  assert.deepEqual(review.submission, submitted.submission);
  assert.deepEqual(review.definition, started.start.definition);
  assert.equal(review.submission.ownership, 'UNCONFIRMED');
  let unauthorizedPrivateQueries = 0;
  assert.equal(
    await transaction((tx) =>
      readPracticeTrialForReview(
        {
          ...tx,
          async query<Row>(sql: string, bindings: readonly (string | null)[]) {
            if (sql.includes('"answer"')) unauthorizedPrivateQueries++;
            return tx.query<Row>(sql, bindings);
          },
        },
        actor,
        reviewInput,
        () => true,
      ),
    ),
    null,
  );
  assert.equal(unauthorizedPrivateQueries, 0);
  assert.equal(
    await transaction((tx) => readPracticeTrialForReview(tx, evaluator, reviewInput, () => false)),
    null,
  );
  assert.deepEqual(
    await transaction((tx) =>
      tx.query(
        'SELECT (SELECT count(*)::int FROM "CommandReceipt") receipts,(SELECT count(*)::int FROM "AuditEvent") audits,(SELECT count(*)::int FROM "OutboxEvent") outbox',
        [],
      ),
    ),
    [
      {
        receipts: beforeRead[0].receipts + 1,
        audits: beforeRead[0].audits + 1,
        outbox: beforeRead[0].outbox,
      },
    ],
  );
  assert.deepEqual(
    await transaction((tx) =>
      lockPracticeReviewAssignment(
        tx,
        evaluator,
        reviewScope,
        (scope) => scope.evaluatorAccountId === evaluator.accountId,
      ),
    ),
    assignment,
  );
  assert.equal(
    await transaction((tx) =>
      lockPracticeReviewAssignment(
        tx,
        evaluator,
        { ...reviewScope, purpose: 'ASSESSMENT_REVIEW' },
        () => true,
      ),
    ),
    null,
  );
  assert.equal(
    await transaction((tx) => lockPracticeReviewAssignment(tx, actor, reviewScope, () => true)),
    null,
  );
  assert.equal(
    await transaction((tx) =>
      lockPracticeReviewAssignment(tx, evaluator, reviewScope, () => false),
    ),
    null,
  );
  const reviewPolicyId = 'synthetic-policy-' + randomUUID();
  const policyInput = {
    version: 'v1',
    policyId: reviewPolicyId,
    expectedRevision: 0,
    definitionReference: started.start.definition.reference,
    purpose: 'OWNERSHIP_REVIEW',
    state: 'APPROVED',
    guidance:
      'Synthetic manual review guidance only; preserve the original accepted rubric/tool rules. No real operating approval.',
  };
  const policyKey = randomUUID();
  const publishPolicy = (body: unknown = policyInput, key = policyKey, enabled = true) =>
    transaction((tx) =>
      publishPracticeReviewPolicy(
        tx,
        { actor, input: body, idempotencyKey: key, requestId: 'synthetic-policy' },
        {
          allowNewWrites: enabled,
          canPublish: (scope: PracticeReviewPolicyScope) =>
            setPolicy(scope) &&
            scope.definitionReference.recordId === trialId &&
            scope.purpose === 'OWNERSHIP_REVIEW',
        },
      ),
    );
  const publishedPolicy = await publishPolicy();
  assert.equal(publishedPolicy.policy.publishedByAccountId, actor.accountId);
  assert.equal(publishedPolicy.policy.state, 'APPROVED');
  assert.equal(publishedPolicy.policy.confirmsOwnership, false);
  assert.equal(publishedPolicy.policy.verifiesSkill, false);
  const policyObservationInput = {
    version: 'v1',
    assignmentId: assignment.id,
    submissionId: submitted.submission.reference.recordId,
    purpose: 'OWNERSHIP_REVIEW',
  };
  const observedPolicy = await transaction((tx) =>
    observeApprovedPracticeReviewPolicy(
      tx,
      evaluator,
      policyObservationInput,
      (scope) => scope.skillId === 'frontend',
    ),
  );
  assert.deepEqual(observedPolicy?.policy, publishedPolicy.policy);
  const policyUseInput = {
    ...policyObservationInput,
    expectedPolicyReference: publishedPolicy.policy.reference,
  };
  assert.deepEqual(
    (
      await transaction((tx) =>
        lockApprovedPracticeReviewPolicy(tx, evaluator, policyUseInput, () => true),
      )
    )?.policy,
    publishedPolicy.policy,
  );
  assert.equal(
    await transaction((tx) =>
      lockApprovedPracticeReviewPolicy(tx, actor, policyUseInput, () => true),
    ),
    null,
  );
  assert.equal(
    await transaction((tx) =>
      lockApprovedPracticeReviewPolicy(tx, evaluator, policyUseInput, () => false),
    ),
    null,
  );
  await assert.rejects(
    () =>
      publishPolicy(
        { ...policyInput, policyId: 'synthetic-alternative-' + randomUUID() },
        randomUUID(),
      ),
    /POLICY_SCOPE_EXISTS/,
  );
  const ownershipBody = {
    version: 'v1',
    assignmentId: assignment.id,
    submissionId: submitted.submission.reference.recordId,
    expectedSubmissionReference: submitted.submission.reference,
    expectedDefinitionReference: started.start.definition.reference,
    expectedRubricReference: started.start.definition.rubric.reference,
    expectedPolicyReference: publishedPolicy.policy.reference,
    expectedOwnershipReference: null,
    decision: 'CONFIRM',
    reason: 'Synthetic evaluator finding based on the original accepted exercise.',
    observations: [
      { kind: 'EXPLANATION', detail: 'Synthetic explanation observation.' },
      { kind: 'MODIFICATION', detail: 'Synthetic bounded modification observation.' },
    ],
  };
  const ownershipKey = randomUUID();
  const canReview = (scope: PracticeTrialOwnershipScope) =>
    scope.actorAccountId === evaluator.accountId &&
    scope.assignmentId === assignment.id &&
    scope.submissionReference.recordId === submitted.submission.reference.recordId &&
    scope.participantId === learnerParticipantId &&
    scope.policyVersionId === publishedPolicy.policy.id;
  const findOwnership = (body: unknown = ownershipBody, key = ownershipKey, enabled = true) =>
    transaction((tx) =>
      recordPracticeTrialOwnership(
        tx,
        { actor: evaluator, input: body, idempotencyKey: key, requestId: 'synthetic-ownership' },
        {
          allowNewWrites: enabled,
          canRead: (scope) => scope.subjectAccountId === learner.accountId,
          canUsePolicy: (scope) => scope.policyVersionId === publishedPolicy.policy.id,
          canReview,
        },
      ),
    );
  const ownership = await findOwnership();
  assert.equal(ownership.status, 'EXECUTED');
  assert.equal(ownership.view.record.ownership, 'CONFIRMED');
  assert.equal(ownership.view.record.verifiesSkill, false);
  assert.equal(ownership.view.record.createsPermissionGrant, false);
  assert.equal(ownership.view.record.policyVersionId, publishedPolicy.policy.id);
  assert.equal(ownership.view.isCurrent, true);
  const correctedOwnership = await findOwnership(
    {
      ...ownershipBody,
      expectedOwnershipReference: ownership.view.record.reference,
      decision: 'MORE_EVIDENCE',
      reason: 'Synthetic correction requests more evidence without a fraud finding.',
    },
    randomUUID(),
  );
  assert.equal(correctedOwnership.view.record.ownership, 'UNCONFIRMED');
  assert.equal(correctedOwnership.view.record.reference.revision, 2);
  const originalFinding = await transaction((tx) =>
    readPracticeTrialOwnership(tx, evaluator, { ...reviewInput, revision: 1 }, () => true),
  );
  assert.deepEqual(originalFinding?.record, ownership.view.record);
  assert.equal(originalFinding?.isCurrent, false);
  assert.equal(
    await transaction((tx) => readPracticeTrialOwnership(tx, actor, reviewInput, () => true)),
    null,
  );
  assert.equal(
    (
      await transaction((tx) =>
        readPracticeTrialSubmission(tx, learner, submitted.submission.reference.recordId),
      )
    )?.ownership,
    'UNCONFIRMED',
  );
  const withdrawnPolicy = await publishPolicy(
    {
      ...policyInput,
      expectedRevision: 1,
      state: 'WITHDRAWN',
      guidance: 'Synthetic explicit withdrawal.',
    },
    randomUUID(),
  );
  assert.equal(withdrawnPolicy.policy.reference.revision, 2);
  const ownershipReplay = await findOwnership(ownershipBody, ownershipKey, false);
  assert.equal(ownershipReplay.status, 'REPLAYED');
  assert.deepEqual(ownershipReplay.view.record, ownership.view.record);
  assert.equal(ownershipReplay.view.isCurrent, false);

  await assert.rejects(
    () =>
      transaction((tx) =>
        lockApprovedPracticeReviewPolicy(tx, evaluator, policyUseInput, () => true),
      ),
    /REVISION_CHANGED/,
  );
  assert.equal(
    await transaction((tx) =>
      observeApprovedPracticeReviewPolicy(tx, evaluator, policyObservationInput, () => true),
    ),
    null,
  );
  assert.deepEqual(
    (
      await transaction((tx) =>
        readPracticeReviewPolicyAsAdmin(tx, actor, reviewPolicyId, 1, (scope) => setPolicy(scope)),
      )
    )?.policy,
    publishedPolicy.policy,
  );
  assert.deepEqual(
    (await publishPolicy(policyInput, policyKey, false)).policy,
    publishedPolicy.policy,
  );
  const reapproved = await publishPolicy(
    {
      ...policyInput,
      expectedRevision: 2,
      guidance: 'Synthetic reapproval only; original accepted rules still apply.',
    },
    randomUUID(),
  );
  assert.equal(reapproved.policy.reference.revision, 3);
  assert.deepEqual(
    (
      await transaction((tx) =>
        observeApprovedPracticeReviewPolicy(tx, evaluator, policyObservationInput, () => true),
      )
    )?.policy,
    reapproved.policy,
  );
  await transaction((tx) =>
    revokePracticeReviewAssignment(
      tx,
      {
        actor,
        input: {
          version: 'v1',
          assignmentId: assignment.id,
          reason: 'Synthetic current revocation.',
        },
        idempotencyKey: randomUUID(),
        requestId: 'synthetic-revoke',
      },
      { allowNewWrites: true, canManage: scopedPolicy },
    ),
  );
  assert.equal(
    await transaction((tx) => lockPracticeReviewAssignment(tx, evaluator, reviewScope, () => true)),
    null,
  );
  assert.equal(
    await transaction((tx) => readPracticeTrialForReview(tx, evaluator, reviewInput, () => true)),
    null,
  );
  assert.equal(
    await transaction((tx) =>
      observeApprovedPracticeReviewPolicy(tx, evaluator, policyObservationInput, () => true),
    ),
    null,
  );
  assert.equal(
    await transaction((tx) => readPracticeTrialOwnership(tx, evaluator, reviewInput, () => true)),
    null,
  );
  await assert.rejects(
    () => findOwnership(ownershipBody, ownershipKey, false),
    /RESOURCE_UNAVAILABLE/,
  );
  assert.deepEqual((await assign(false)).assignment, assignment);
  assert.equal(
    (
      await transaction((tx) =>
        readPracticeTrialSubmission(tx, learner, submitted.submission.reference.recordId),
      )
    )?.ownership,
    'UNCONFIRMED',
  );
  allowed.clear();
  await assert.rejects(() => save(input, key, false), /FORBIDDEN/);
  assert.deepEqual((await begin(false)).start, started.start);
  assert.deepEqual(
    (await submit(submissionInput, submissionKey, false)).submission,
    submitted.submission,
  );
  const revokeClient = await pool.connect();
  try {
    await revokeClient.query('DELETE FROM "Session" WHERE "tokenHash"=$1', [learner.sessionHash]);
  } finally {
    revokeClient.release();
  }
  await assert.rejects(() => begin(false), /AUTHENTICATION_REQUIRED/);
  await assert.rejects(
    () => submit(submissionInput, submissionKey, false),
    /AUTHENTICATION_REQUIRED/,
  );
  console.log(
    JSON.stringify({
      synthetic: true,
      actualPostgreSQL: true,
      actualCanonicalApprovedPolicySource: true,
      actualAttributedOwnershipHistory: true,
      immutableOwnershipCorrectionAndCAS: true,
      originalOwnershipRetryAfterPolicyWithdrawal: true,
      privateOwnershipHistoryCurrentScope: true,
      ownershipFindingsNeverVerifyRank: true,
      noCallerInventedPolicyVersion: true,
      uniqueOriginalDefinitionPurposePolicy: true,
      immutablePolicyWithdrawalReapprovalAndHistory: true,
      policyDoesNotConfirmOwnershipOrRank: true,
      scopedCurrentPolicyUnavailableAfterGrantRevocation: true,
      actualProtectedPrivateReviewRead: true,
      exactOriginalPrivateBytesAndRubric: true,
      noPrivateSelectionWithoutAssignment: true,
      noReturnedBytesAfterRevocation: true,
      readRecordsPrivateIdentifierAuditBeforeBody: true,
      readCreatesNoBusinessMutationOrOutbox: true,
      explicitSubmissionPurposeAndExpiry: true,
      actualEvaluatorSessionAndScopedPolicy: true,
      immutableRevocationAndOriginalReceipt: true,
      privateAnswersNotReadByAssignmentPort: true,
      immutablePrivateSubmission: true,
      exactCodeWhitespace: true,
      originalConsentAfterRetirement: true,
      ownershipRemainsUnconfirmed: true,
      originalSubmissionAfterDisablement: true,
      actualCanonicalHuman: true,
      canonicalFamilyLimit: true,
      originalStartAfterRetirementAndDisablement: true,
      ordinarySessionRevocationDenied: true,
      immutableGlobalRubric: true,
      originalReceiptAfterRetirement: true,
      alternateScopedPolicy: true,
      currentRevocationDenied: true,
      noRankCapacityMoneyOrProvider: true,
    }),
  );
} finally {
  await pool.end();
}
