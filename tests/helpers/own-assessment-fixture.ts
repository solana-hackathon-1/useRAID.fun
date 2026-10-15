import { randomUUID, randomBytes } from 'node:crypto';
import { db } from '../../src/lib/db';
import { hash } from '../../src/lib/auth-primitives';
import { runCommandTransaction } from '../../src/lib/command-receipts-adapter';
import { publishSkillTaxonomy, type SkillTaxonomyActor } from '../../src/skills/taxonomy-storage';
import { publishPracticeTrialDefinition } from '../../src/skills/practice-trial-storage';
import { startPracticeTrial } from '../../src/skills/practice-trial-attempt-storage';
import { submitPracticeTrial } from '../../src/skills/practice-trial-submission-storage';
import {
  issuePracticeReviewAssignment,
  type PracticeReviewAssignmentOptions,
} from '../../src/skills/practice-review-assignment-storage';
import { definition as fixture } from '../../examples/skill-assessments/fixtures';
import { assertTestDatabase, truncateAll } from './db-guard';
const catalogId = 'synthetic-submission-catalog',
  trialId = 'synthetic-submission-trial';
let publisher: SkillTaxonomyActor,
  subject: SkillTaxonomyActor,
  startId: string,
  participantId: string;
const skills = [
  { id: 'frontend', domain: 'web', name: 'Frontend', status: 'ACTIVE', aliases: ['frontend'] },
];
async function actor(admin = false, mapped = true) {
  const user = await db.user.create({
    data: {
      handle: 'synthetic',
      role: admin ? 'ADMIN' : 'CREATOR',
      xId: admin ? randomUUID() : null,
    },
  });
  const sessionHash = hash(randomUUID());
  await db.session.create({
    data: {
      tokenHash: sessionHash,
      userId: user.id,
      via: admin ? 'x' : 'wallet',
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  if (mapped)
    await db.participant.create({
      data: {
        accountId: user.id,
        provisionActorAccountId: user.id,
        provisionRequestId: 'synthetic-provision',
      },
    });
  return { accountId: user.id, sessionHash };
}
const publishCatalog = (revision = 0, entries: unknown = skills) =>
  runCommandTransaction(db, (tx) =>
    publishSkillTaxonomy(
      tx,
      {
        actor: publisher,
        input: { taxonomyId: catalogId, expectedRevision: revision, skills: entries },
        idempotencyKey: randomUUID(),
        requestId: 'synthetic-catalog',
      },
      { allowNewWrites: true, canPublish: () => true },
    ),
  );
function definitionInput(revision = 0, availability = 'AVAILABLE') {
  const draft = structuredClone(fixture);
  for (const field of ['reference', 'publishedAt', 'state']) Reflect.deleteProperty(draft, field);
  return {
    trialId,
    expectedRevision: revision,
    taxonomyReference: { recordId: catalogId, revision: 1 },
    availability,
    draft: {
      ...draft,
      maximumAttempts: 3,
      cooldownSeconds: 0,
      rubric: {
        ...draft.rubric,
        reference: { recordId: 'synthetic-submission-rubric', revision: 1 },
      },
    },
  };
}
const publish = (revision = 0, availability = 'AVAILABLE') =>
  runCommandTransaction(db, (tx) =>
    publishPracticeTrialDefinition(
      tx,
      {
        actor: publisher,
        input: definitionInput(revision, availability),
        idempotencyKey: randomUUID(),
        requestId: 'synthetic-definition',
      },
      { allowNewWrites: true, canPublish: () => true },
    ),
  );
const begin = (a = subject) =>
  runCommandTransaction(db, (tx) =>
    startPracticeTrial(
      tx,
      {
        actor: a,
        input: {
          version: 'v1',
          definitionReference: { recordId: trialId, revision: 1 },
          accommodationReference: null,
        },
        idempotencyKey: randomUUID(),
        requestId: 'synthetic-start',
      },
      { allowNewWrites: true },
    ),
  );
function input() {
  return {
    version: 'v1',
    startId,
    expectedDefinitionReference: { recordId: trialId, revision: 1 },
    expectedRubricReference: { recordId: 'synthetic-submission-rubric', revision: 1 },
    answer: '\n  const answer = "<script>literal</script>";\r\n',
    explanation: 'I can explain and modify this invented solution.',
    toolsUsed: ['editor'],
    aiAssistanceUsed: false,
    assistanceDisclosure: 'No AI assistance declared.',
  };
}
const submit = (a = subject, body: unknown = input(), key = randomUUID(), enabled = true) =>
  runCommandTransaction(db, (tx) =>
    submitPracticeTrial(
      tx,
      { actor: a, input: body, idempotencyKey: key, requestId: 'synthetic-submit' },
      { allowNewWrites: enabled },
    ),
  );

let evaluator: SkillTaxonomyActor, submissionId: string;
const policy: PracticeReviewAssignmentOptions = {
  allowNewWrites: true,
  canManage: (s) =>
    s.issuerAccountId === publisher.accountId &&
    s.evaluatorAccountId === evaluator.accountId &&
    s.subjectAccountId === subject.accountId &&
    s.participantId === participantId &&
    s.skillId === 'frontend',
};
const grantInput = () => ({
  version: 'v1',
  submissionId,
  evaluatorAccountId: evaluator.accountId,
  purpose: 'OWNERSHIP_REVIEW',
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  reason: 'Synthetic bounded ownership review.',
});
const issue = (body: unknown = grantInput(), a = publisher, opts = policy, key = randomUUID()) =>
  runCommandTransaction(db, (tx) =>
    issuePracticeReviewAssignment(
      tx,
      { actor: a, input: body, idempotencyKey: key, requestId: 'synthetic-issue' },
      opts,
    ),
  );

import {
  publishPracticeReviewPolicy,
  type PracticeReviewPolicyOptions,
} from '../../src/skills/practice-review-policy-storage';
const policyId = 'synthetic-ownership-policy';
let assignmentId: string;
const policyInput = () => ({
  version: 'v1',
  policyId,
  expectedRevision: 0,
  definitionReference: { recordId: trialId, revision: 1 },
  purpose: 'OWNERSHIP_REVIEW',
  state: 'APPROVED',
  guidance:
    'Synthetic manual review guidance; original accepted rubric/tool rules remain authoritative.',
});
const publicationOptions: PracticeReviewPolicyOptions = {
  allowNewWrites: true,
  canPublish: (scope) =>
    scope.accountId === publisher.accountId &&
    scope.definitionReference.recordId === trialId &&
    scope.skillId === 'frontend',
};
const publishPolicy = (
  body: unknown = policyInput(),
  a = publisher,
  options = publicationOptions,
  key = randomUUID(),
) =>
  runCommandTransaction(db, (tx) =>
    publishPracticeReviewPolicy(
      tx,
      { actor: a, input: body, idempotencyKey: key, requestId: 'synthetic-policy' },
      options,
    ),
  );

import {
  type PracticeTrialOwnershipOptions,
  recordPracticeTrialOwnership,
} from '../../src/skills/practice-trial-ownership-storage';
const ownershipInput = () => ({
  version: 'v1',
  assignmentId,
  submissionId,
  expectedSubmissionReference: { recordId: submissionId, revision: 1 },
  expectedDefinitionReference: { recordId: trialId, revision: 1 },
  expectedRubricReference: { recordId: 'synthetic-submission-rubric', revision: 1 },
  expectedPolicyReference: { recordId: policyId, revision: 1 },
  expectedOwnershipReference: null,
  decision: 'CONFIRM',
  reason: 'Synthetic evaluator observed explanation and modification under original rules.',
  observations: [
    {
      kind: 'EXPLANATION',
      detail: 'Synthetic explanation reviewed against saved original solution.',
    },
    { kind: 'MODIFICATION', detail: 'Synthetic bounded modification observed.' },
  ],
});
const ownershipOptions: PracticeTrialOwnershipOptions = {
  allowNewWrites: true,
  canRead: () => true,
  canUsePolicy: () => true,
  canReview: () => true,
};
const recordOwnership = (
  body: unknown = ownershipInput(),
  a = evaluator,
  options = ownershipOptions,
  key = randomUUID(),
) =>
  runCommandTransaction(db, (tx) =>
    recordPracticeTrialOwnership(
      tx,
      { actor: a, input: body, idempotencyKey: key, requestId: 'synthetic-ownership' },
      options,
    ),
  );

import {
  type PracticeTrialAssessmentOptions,
  recordPracticeTrialAssessment,
} from '../../src/skills/practice-trial-assessment-storage';
let assessmentAssignmentId: string,
  confirmedOwnershipReference: { recordId: string; revision: number };
const assessmentPolicyId = 'synthetic-assessment-policy';
const assessmentInput = () => ({
  version: 'v1',
  assignmentId: assessmentAssignmentId,
  submissionId,
  expectedSubmissionReference: { recordId: submissionId, revision: 1 },
  expectedDefinitionReference: { recordId: trialId, revision: 1 },
  expectedRubricReference: { recordId: 'synthetic-submission-rubric', revision: 1 },
  expectedPolicyReference: { recordId: assessmentPolicyId, revision: 1 },
  expectedOwnershipReference: confirmedOwnershipReference,
  expectedReviewReference: null,
  expectedAssessmentReference: null,
  decision: 'VERIFY',
  reason: 'Synthetic authorized reviewer applied original manual pass conditions.',
  confidenceStatement: 'One actual invented case; no broad expertise guarantee.',
  criteria: fixture.rubric.criteria.map((c) => ({
    criterionId: c.id,
    result: 'MET',
    reason: 'Synthetic criterion observation ' + c.id,
  })),
  reassessmentAt: null,
});
const assessmentOptions: PracticeTrialAssessmentOptions = {
  allowNewWrites: true,
  canRead: () => true,
  canUsePolicy: () => true,
  canReview: () => true,
};
const recordAssessment = (
  body: unknown = assessmentInput(),
  a = evaluator,
  options = assessmentOptions,
  key = randomUUID(),
) =>
  runCommandTransaction(db, (tx) =>
    recordPracticeTrialAssessment(
      tx,
      { actor: a, input: body, idempotencyKey: key, requestId: 'synthetic-assessment' },
      options,
    ),
  );

import {
  observePracticeTrialAssessmentContext,
  recordPracticeAssessmentDecision,
} from '../../src/skills/practice-trial-assessment-storage';
export async function seedOwnAssessmentFixture(createVerified = true) {
  assertTestDatabase();

  await truncateAll(db);
  publisher = await actor(true, false);
  subject = await actor();
  evaluator = await actor(false, false);
  await publishCatalog();
  await publish();
  const s = await begin();
  startId = s.start.id;
  participantId = s.start.participantId;
  submissionId = (await submit()).submission.reference.recordId;
  assignmentId = (await issue()).assignment.id;
  await publishPolicy();
  confirmedOwnershipReference = (await recordOwnership()).view.record.reference;
  assessmentAssignmentId = (await issue({ ...grantInput(), purpose: 'ASSESSMENT_REVIEW' }))
    .assignment.id;
  await publishPolicy({
    ...policyInput(),
    policyId: assessmentPolicyId,
    purpose: 'ASSESSMENT_REVIEW',
  });
  const issued = createVerified ? await recordAssessment() : null;
  const cookie = randomBytes(32).toString('base64url'),
    cookieHash = hash(cookie);
  await db.session.create({
    data: {
      tokenHash: cookieHash,
      userId: subject.accountId,
      via: 'wallet',
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  return {
    cookie,
    cookieHash,
    ownerId: subject.accountId,
    participantId,
    submissionId,
    issued,
    async decide(action: 'REQUIRE_REASSESSMENT' | 'REVOKE') {
      const context = await runCommandTransaction(db, (tx) =>
        observePracticeTrialAssessmentContext(
          tx,
          evaluator,
          { version: 'v1', assignmentId: assessmentAssignmentId, submissionId },
          () => true,
        ),
      );
      if (
        !context?.currentAssessmentReference ||
        !context.currentReviewReference ||
        !context.currentOwnershipReference
      )
        throw Error('Synthetic current source unavailable');
      return runCommandTransaction(db, (tx) =>
        recordPracticeAssessmentDecision(
          tx,
          {
            actor: evaluator,
            input: {
              version: 'v1',
              assignmentId: assessmentAssignmentId,
              submissionId,
              expectedAssessmentReference: context.currentAssessmentReference,
              expectedReviewReference: context.currentReviewReference,
              expectedOwnershipReference: context.currentOwnershipReference,
              expectedPolicyReference: { recordId: assessmentPolicyId, revision: 1 },
              action,
              reasonCategory:
                action === 'REVOKE' ? 'FRAUDULENT_ASSESSMENT_EVIDENCE' : 'CAPABILITY_RECHECK',
              reason: 'Synthetic bounded original-case finding.',
              findings: [
                {
                  kind: action === 'REVOKE' ? 'ASSESSMENT_EVIDENCE' : 'CAPABILITY_EVIDENCE',
                  detail: 'Synthetic actual manual observation.',
                },
              ],
              dueAt: action === 'REVOKE' ? null : new Date(Date.now() + 3600000).toISOString(),
            },
            idempotencyKey: randomUUID(),
            requestId: 'synthetic-browser-decision',
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
