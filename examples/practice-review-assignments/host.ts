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
