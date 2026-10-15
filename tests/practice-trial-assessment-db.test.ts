import { lockApprovedPracticeReviewPolicy } from '../src/skills/practice-review-policy-storage';
import { readPracticeTrialForReview } from '../src/skills/practice-review-read-storage';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/lib/db';
import { hash } from '../src/lib/auth-primitives';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { executeIdempotentCommand, type CommandOutcome } from '../src/command-receipts';
import { publishSkillTaxonomy, type SkillTaxonomyActor } from '../src/skills/taxonomy-storage';
import { publishPracticeTrialDefinition } from '../src/skills/practice-trial-storage';
import { startPracticeTrial } from '../src/skills/practice-trial-attempt-storage';
import {
  submitPracticeTrial,
  readPracticeTrialSubmission,
} from '../src/skills/practice-trial-submission-storage';
import {
  issuePracticeReviewAssignment,
  revokePracticeReviewAssignment,
  type PracticeReviewAssignmentOptions,
} from '../src/skills/practice-review-assignment-storage';
import { definition as fixture } from '../examples/skill-assessments/fixtures';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
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
      expiresAt: new Date(Date.now() + 60000),
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
  expiresAt: new Date(Date.now() + 60000).toISOString(),
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
const revoke = (
  id: string,
  a = publisher,
  opts = policy,
  key = randomUUID(),
  reason = 'Synthetic case access revoked.',
) =>
  runCommandTransaction(db, (tx) =>
    revokePracticeReviewAssignment(
      tx,
      {
        actor: a,
        input: { version: 'v1', assignmentId: id, reason },
        idempotencyKey: key,
        requestId: 'synthetic-revoke',
      },
      opts,
    ),
  );

import {
  publishPracticeReviewPolicy,
  type PracticeReviewPolicyOptions,
} from '../src/skills/practice-review-policy-storage';
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
  readPracticeTrialOwnership,
} from '../src/skills/practice-trial-ownership-storage';
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
  observePracticeTrialAssessmentContext,
  PracticeTrialAssessmentViewSchema,
  type PracticeTrialAssessmentOptions,
  recordPracticeTrialAssessment,
  readPracticeTrialAssessment,
} from '../src/skills/practice-trial-assessment-storage';
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
const readAssessment = (
  revision: number | undefined = undefined,
  a = evaluator,
  id = assessmentAssignmentId,
  canRead = assessmentOptions.canRead,
) =>
  runCommandTransaction(db, (tx) =>
    readPracticeTrialAssessment(
      tx,
      a,
      { version: 'v1', assignmentId: id, submissionId, revision },
      canRead,
    ),
  );
integration('T013D5 actual manual assessment storage', () => {
  beforeAll(() => assertTestDatabase());
  beforeEach(async () => {
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
  });
  afterAll(() => db.$disconnect());
  it('commits actual manual VERIFIED rank from original case/criteria/current ownership/approved policy rather than a claimant declaration or proposal', async () => {
    const r = await recordAssessment();
    expect(r.status).toBe('EXECUTED');
    expect(r.view.review).toMatchObject({
      reference: { recordId: submissionId, revision: 1 },
      assignmentId: assessmentAssignmentId,
      evaluatorAccountId: evaluator.accountId,
      decision: 'VERIFY',
      createsVerifiedAssessment: true,
      persisted: true,
      isAuthorizationToken: false,
      createsPermissionGrant: false,
      consumesCapacity: false,
      createsFinancialObligation: false,
    });
    expect(r.view.assessment).toMatchObject({
      version: 'v1',
      participantId,
      skillId: 'frontend',
      skillDomain: 'web',
      state: 'VERIFIED',
      assessedRank: 'A',
      submissionReference: { recordId: submissionId, revision: 1 },
      definitionReference: { recordId: trialId, revision: 1 },
      rubricReference: { recordId: 'synthetic-submission-rubric', revision: 1 },
      assessmentPolicyVersion: r.view.review.policyVersionId,
      evaluatorAccountId: evaluator.accountId,
      sampleSize: 1,
      evidenceReferences: [{ recordId: submissionId, revision: 1 }],
    });
    expect(r.view.isCurrentReview).toBe(true);
    expect(r.view.isCurrentAssessment).toBe(true);
    expect(
      (
        await runCommandTransaction(db, (tx) =>
          readPracticeTrialSubmission(tx, subject, submissionId),
        )
      )?.ownership,
    ).toBe('UNCONFIRMED');
    expect(await db.outboxEvent.count()).toBe(0);
  });
  it('has no assessment/review from confirmed ownership alone', async () => {
    expect(await readAssessment()).toBeNull();
    expect(await db.$queryRawUnsafe('SELECT count(*)::int n FROM "SkillAssessment"')).toEqual([
      { n: 0 },
    ]);
  });
  it.each(['MORE_EVIDENCE', 'NOT_DEMONSTRATED'])(
    'records reasoned %s without creating a skill assessment',
    async (decision) => {
      const r = await recordAssessment({ ...assessmentInput(), decision });
      expect(r.view.review).toMatchObject({ decision, createsVerifiedAssessment: false });
      expect(r.view.assessment).toBeNull();
      expect(await db.$queryRawUnsafe('SELECT count(*)::int n FROM "SkillAssessment"')).toEqual([
        { n: 0 },
      ]);
    },
  );
  it('does not silently revoke or downgrade an existing VERIFIED assessment when a later review needs more evidence', async () => {
    const first = await recordAssessment();
    const next = await recordAssessment({
      ...assessmentInput(),
      expectedReviewReference: first.view.review.reference,
      expectedAssessmentReference: first.view.assessment!.reference,
      decision: 'MORE_EVIDENCE',
    });
    expect(next.view.assessment).toBeNull();
    expect(next.view.currentAssessmentReference).toEqual(first.view.assessment!.reference);
    expect((await readAssessment(1))?.assessment).toEqual(first.view.assessment);
    expect((await readAssessment(1))?.isCurrentAssessment).toBe(true);
    expect(
      await db.$queryRawUnsafe('SELECT count(*)::int n FROM "SkillAssessmentVersion"'),
    ).toEqual([{ n: 1 }]);
  });
  it('appends actual verification history without inflating the sample size of repeated review of the same evidence', async () => {
    const first = await recordAssessment();
    const next = await recordAssessment({
      ...assessmentInput(),
      expectedReviewReference: first.view.review.reference,
      expectedAssessmentReference: first.view.assessment!.reference,
    });
    expect(next.view.review.reference.revision).toBe(2);
    expect(next.view.assessment!.reference).toEqual({
      ...first.view.assessment!.reference,
      revision: 2,
    });
    expect(next.view.assessment!.sampleSize).toBe(1);
    expect((await readAssessment(1))?.isCurrentAssessment).toBe(false);
    expect((await readAssessment(1))?.assessment).toEqual(first.view.assessment);
  });
  it('recovers the original historical result after correction/writeoff/policy withdrawal under current case read authority', async () => {
    const key = randomUUID(),
      body = assessmentInput(),
      first = await recordAssessment(body, evaluator, assessmentOptions, key);
    await recordAssessment({
      ...body,
      expectedReviewReference: first.view.review.reference,
      expectedAssessmentReference: first.view.assessment!.reference,
    });
    await publishPolicy({
      ...policyInput(),
      policyId: assessmentPolicyId,
      purpose: 'ASSESSMENT_REVIEW',
      expectedRevision: 1,
      state: 'WITHDRAWN',
    });
    const replay = await recordAssessment(
      body,
      evaluator,
      {
        ...assessmentOptions,
        allowNewWrites: false,
        canReview: () => false,
        canUsePolicy: () => false,
      },
      key,
    );
    expect(replay.status).toBe('REPLAYED');
    expect(replay.view.review).toEqual(first.view.review);
    expect(replay.view.assessment).toEqual(first.view.assessment);
    expect(replay.view.isCurrentReview).toBe(false);
    expect(replay.view.isCurrentAssessment).toBe(false);
  });
  it('rejects changed same-key body using the shared receipt contract', async () => {
    const key = randomUUID();
    await recordAssessment(assessmentInput(), evaluator, assessmentOptions, key);
    await expect(
      recordAssessment(
        { ...assessmentInput(), reason: 'Changed' },
        evaluator,
        assessmentOptions,
        key,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });
  it('CAS protects both review and participant-skill source under simultaneous decisions', async () => {
    const r = await Promise.allSettled([
      recordAssessment(),
      recordAssessment({ ...assessmentInput(), decision: 'MORE_EVIDENCE' }),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(r.find((x) => x.status === 'rejected')).toMatchObject({
      reason: { code: 'REVISION_CHANGED' },
    });
  });
  it.each([
    'expectedSubmissionReference',
    'expectedDefinitionReference',
    'expectedRubricReference',
    'expectedPolicyReference',
    'expectedOwnershipReference',
    'expectedReviewReference',
    'expectedAssessmentReference',
  ])('rejects stale or foreign %s', async (field) => {
    await expect(
      recordAssessment({ ...assessmentInput(), [field]: { recordId: 'foreign', revision: 1 } }),
    ).rejects.toMatchObject({ code: 'REVISION_CHANGED' });
  });
  it('requires a current confirmed ownership source even when every criterion is MET', async () => {
    const current = await recordOwnership({
      ...ownershipInput(),
      expectedOwnershipReference: confirmedOwnershipReference,
      decision: 'MORE_EVIDENCE',
    });
    await expect(
      recordAssessment({
        ...assessmentInput(),
        expectedOwnershipReference: current.view.record.reference,
      }),
    ).rejects.toMatchObject({ code: 'EVIDENCE_NOT_CONFIRMED' });
  });
  it('requires every original required criterion MET and exact criterion coverage', async () => {
    await expect(
      recordAssessment({ ...assessmentInput(), criteria: assessmentInput().criteria.slice(0, 1) }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      recordAssessment({
        ...assessmentInput(),
        criteria: assessmentInput().criteria.map((c) => ({ ...c, result: 'UNCERTAIN' })),
      }),
    ).rejects.toMatchObject({ code: 'RUBRIC_NOT_MET' });
  });
  it('cannot substitute ownership appointment, admin role or claimant for current assessment appointment', async () => {
    await expect(recordAssessment({ ...assessmentInput(), assignmentId })).rejects.toMatchObject({
      code: 'RESOURCE_UNAVAILABLE',
    });
    await expect(recordAssessment(assessmentInput(), publisher)).rejects.toMatchObject({
      code: 'RESOURCE_UNAVAILABLE',
    });
    await expect(recordAssessment(assessmentInput(), subject)).rejects.toMatchObject({
      code: 'RESOURCE_UNAVAILABLE',
    });
  });
  it('denies lost own evaluator session for new decisions and original retries', async () => {
    const key = randomUUID();
    await recordAssessment(assessmentInput(), evaluator, assessmentOptions, key);
    await db.session.delete({ where: { tokenHash: evaluator.sessionHash } });
    await expect(
      recordAssessment(assessmentInput(), evaluator, assessmentOptions, key),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
  });
  it('denies revoked current assignment for new writes/read/replay', async () => {
    const key = randomUUID();
    await recordAssessment(assessmentInput(), evaluator, assessmentOptions, key);
    await revoke(assessmentAssignmentId);
    expect(await readAssessment()).toBeNull();
    await expect(
      recordAssessment(assessmentInput(), evaluator, assessmentOptions, key),
    ).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
  });
  it('denies withdrawn actual policy rather than treating a client label as approval', async () => {
    await publishPolicy({
      ...policyInput(),
      policyId: assessmentPolicyId,
      purpose: 'ASSESSMENT_REVIEW',
      expectedRevision: 1,
      state: 'WITHDRAWN',
    });
    await expect(
      recordAssessment({
        ...assessmentInput(),
        expectedPolicyReference: { recordId: assessmentPolicyId, revision: 2 },
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
  });
  it('preserves off-state without creating a new review/rank or successful command receipt', async () => {
    await expect(
      recordAssessment(assessmentInput(), evaluator, {
        ...assessmentOptions,
        allowNewWrites: false,
      }),
    ).rejects.toMatchObject({ code: 'WRITES_DISABLED' });
    expect(
      await db.commandReceipt.count({ where: { commandKind: 'RecordPracticeTrialAssessment' } }),
    ).toBe(0);
  });
  it.each(['canRead', 'canUsePolicy', 'canReview'])(
    'fails closed on current %s denial',
    async (field) => {
      await expect(
        recordAssessment(assessmentInput(), evaluator, {
          ...assessmentOptions,
          [field]: () => false,
        }),
      ).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
    },
  );
  it.each([
    { assessedRank: 'S' },
    { sampleSize: 1000 },
    { assessmentPolicyVersion: 'client-approved' },
    { approved: true },
    { evidenceReferences: [{ recordId: 'guessed', revision: 1 }] },
  ])('rejects caller-invented committed facts %s', async (patch) => {
    await expect(recordAssessment({ ...assessmentInput(), ...patch })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
  it.each(['', '😀'.repeat(1001), 'x\0', 'x\ud800'])(
    'rejects malformed private reason before any persistence %s',
    async (reason) => {
      await expect(recordAssessment({ ...assessmentInput(), reason })).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    },
  );
  it('returns private history only to the exact actual current assessment reviewer', async () => {
    const r = await recordAssessment();
    expect(await readAssessment(undefined, publisher)).toBeNull();
    expect(await readAssessment(undefined, evaluator, assignmentId)).toBeNull();
    expect((await readAssessment())?.review).toEqual(r.view.review);
  });
  async function secondCase(
    draftPatch: Record<string, unknown> = {},
    submissionPatch: Record<string, unknown> = {},
  ) {
    const definition = definitionInput(1);
    await runCommandTransaction(db, (tx) =>
      publishPracticeTrialDefinition(
        tx,
        {
          actor: publisher,
          input: { ...definition, draft: { ...definition.draft, ...draftPatch } },
          idempotencyKey: randomUUID(),
          requestId: 'synthetic-second-definition',
        },
        { allowNewWrites: true, canPublish: () => true },
      ),
    );
    const started = await runCommandTransaction(db, (tx) =>
      startPracticeTrial(
        tx,
        {
          actor: subject,
          input: {
            version: 'v1',
            definitionReference: { recordId: trialId, revision: 2 },
            accommodationReference: null,
          },
          idempotencyKey: randomUUID(),
          requestId: 'synthetic-second-start',
        },
        { allowNewWrites: true },
      ),
    );
    startId = started.start.id;
    submissionId = (
      await submit(subject, {
        ...input(),
        ...submissionPatch,
        expectedDefinitionReference: { recordId: trialId, revision: 2 },
      })
    ).submission.reference.recordId;
    assignmentId = (await issue()).assignment.id;
    const ownPolicy = 'synthetic-second-ownership-policy';
    await publishPolicy({
      ...policyInput(),
      policyId: ownPolicy,
      definitionReference: { recordId: trialId, revision: 2 },
    });
    confirmedOwnershipReference = (
      await recordOwnership({
        ...ownershipInput(),
        expectedDefinitionReference: { recordId: trialId, revision: 2 },
        expectedPolicyReference: { recordId: ownPolicy, revision: 1 },
      })
    ).view.record.reference;
    assessmentAssignmentId = (await issue({ ...grantInput(), purpose: 'ASSESSMENT_REVIEW' }))
      .assignment.id;
    const assessPolicy = 'synthetic-second-assessment-policy';
    await publishPolicy({
      ...policyInput(),
      policyId: assessPolicy,
      purpose: 'ASSESSMENT_REVIEW',
      definitionReference: { recordId: trialId, revision: 2 },
    });
    return {
      ...assessmentInput(),
      expectedDefinitionReference: { recordId: trialId, revision: 2 },
      expectedPolicyReference: { recordId: assessPolicy, revision: 1 },
    };
  }
  it('cannot turn one actual case into repeated strong independent S-rank evidence', async () => {
    const body = await secondCase({ targetRank: 'S' });
    await expect(recordAssessment(body)).rejects.toMatchObject({
      code: 'HIGH_RANK_EVIDENCE_REQUIRED',
    });
  });
  it('cannot fabricate actual automated evaluation from a manual criterion declaration', async () => {
    const body = await secondCase({ evaluatorMethod: 'AUTOMATED_WITH_MANUAL_REVIEW' });
    await expect(recordAssessment(body)).rejects.toMatchObject({
      code: 'AUTOMATED_EVIDENCE_UNAVAILABLE',
    });
  });
  it.each(['unlisted-tool', 'prohibited-ai'])(
    'cannot verify admitted original tool-rule violation %s despite confirmed ownership and MET criteria',
    async (change) => {
      const body = await secondCase(
        change === 'prohibited-ai'
          ? { tools: { ...fixture.tools, aiAssistance: 'PROHIBITED' } }
          : {},
        change === 'prohibited-ai'
          ? {
              aiAssistanceUsed: true,
              assistanceDisclosure: 'Synthetic AI use explicitly admitted.',
            }
          : { toolsUsed: ['unlisted-tool'] },
      );
      await expect(recordAssessment(body)).rejects.toMatchObject({ code: 'TOOLS_POLICY_NOT_MET' });
    },
  );
  it('does not silently replace higher current VERIFIED capacity just because a lower new trial was passed', async () => {
    const first = await recordAssessment();
    const body = await secondCase({ targetRank: 'C' });
    await expect(
      recordAssessment({ ...body, expectedAssessmentReference: first.view.assessment!.reference }),
    ).rejects.toMatchObject({ code: 'CURRENT_HIGHER_ASSESSMENT' });
  });
  it('audits private review and rank fields before selection and fails closed if access audit persistence fails', async () => {
    await recordAssessment();
    let selected = false;
    const run = (failAudit: boolean) =>
      runCommandTransaction(db, (tx) =>
        readPracticeTrialAssessment(
          {
            ...tx,
            async query<Row>(sql: string, bindings: readonly (string | null)[]) {
              if (failAudit && sql.includes('INSERT INTO "AuditEvent"'))
                throw new Error('private-assessment-audit-marker');
              if (sql.includes('r."reason"') && sql.includes('r."criteria"')) {
                const [a] = await tx.query<{ n: number }>(
                  'SELECT count(*)::int n FROM "AuditEvent" WHERE "eventType"=$1',
                  ['skill.practice_assessment_review_access_authorized.v1'],
                );
                expect(a.n).toBeGreaterThanOrEqual(2);
                selected = true;
              }
              return tx.query<Row>(sql, bindings);
            },
          },
          evaluator,
          { version: 'v1', assignmentId: assessmentAssignmentId, submissionId },
          () => true,
        ),
      );
    expect((await run(false))?.private).toBe(true);
    expect(selected).toBe(true);
    selected = false;
    const failure = run(true);
    await expect(failure).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await expect(failure).rejects.not.toThrow('private-assessment-audit-marker');
    expect(selected).toBe(false);
  });
  it.each(['canRead', 'canUsePolicy', 'canReview'])(
    'rolls back a new assessment if current %s closes during private result selection',
    async (check) => {
      let enabled = true;
      const failure = runCommandTransaction(db, (tx) =>
        recordPracticeTrialAssessment(
          {
            ...tx,
            async query<Row>(sql: string, bindings: readonly (string | null)[]) {
              const rows = await tx.query<Row>(sql, bindings);
              if (sql.includes('r."reason"') && sql.includes('r."criteria"')) enabled = false;
              return rows;
            },
          },
          {
            actor: evaluator,
            input: assessmentInput(),
            idempotencyKey: randomUUID(),
            requestId: 'synthetic-result-scope',
          },
          { ...assessmentOptions, [check]: () => enabled },
        ),
      );
      await expect(failure).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
      expect(await readAssessment()).toBeNull();
      expect(await db.$queryRawUnsafe('SELECT count(*)::int n FROM "SkillAssessment"')).toEqual([
        { n: 0 },
      ]);
    },
  );
  it.each(['canRead', 'canUsePolicy'])(
    'fences distinct %s after the final grant query following actual policy authorization',
    async (check) => {
      let selected = false,
        guide = false,
        authorized = false,
        enabled = true,
        triggered = false;
      const failure = runCommandTransaction(db, (tx) =>
        recordPracticeTrialAssessment(
          {
            ...tx,
            async query<Row>(sql: string, bindings: readonly (string | null)[]) {
              const rows = await tx.query<Row>(sql, bindings);
              if (sql.includes('r."reason"') && sql.includes('r."criteria"')) selected = true;
              if (selected && sql.includes('SELECT "guidance"')) guide = true;
              if (authorized && sql.includes('SELECT "expiresAt">clock_timestamp() AS valid')) {
                enabled = false;
                triggered = true;
              }
              return rows;
            },
          },
          {
            actor: evaluator,
            input: assessmentInput(),
            idempotencyKey: randomUUID(),
            requestId: 'synthetic-last-scope',
          },
          {
            ...assessmentOptions,
            canRead: () => (check === 'canRead' ? enabled : true),
            canUsePolicy: () => {
              if (guide) authorized = true;
              return check === 'canUsePolicy' ? enabled : true;
            },
          },
        ),
      );
      await expect(failure).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
      expect(triggered).toBe(true);
      expect(await readAssessment()).toBeNull();
    },
  );
  it('drops historical private fields if current read scope closes during selection', async () => {
    await recordAssessment();
    let enabled = true;
    const r = await runCommandTransaction(db, (tx) =>
      readPracticeTrialAssessment(
        {
          ...tx,
          async query<Row>(sql: string, bindings: readonly (string | null)[]) {
            const rows = await tx.query<Row>(sql, bindings);
            if (sql.includes('r."reason"') && sql.includes('r."criteria"')) enabled = false;
            return rows;
          },
        },
        evaluator,
        { version: 'v1', assignmentId: assessmentAssignmentId, submissionId },
        () => enabled,
      ),
    );
    expect(r).toBeNull();
  });
  it('keeps review/assessment audit identifier-only without private criterion reasons or public outbox', async () => {
    const r = await recordAssessment();
    await readAssessment();
    const rows = await db.$queryRawUnsafe<{ payload: Record<string, string> }[]>(
      'SELECT "payload" FROM "AuditEvent" WHERE "eventType" LIKE $1 OR "eventType"=$2',
      'skill.practice_assessment_%',
      'skill.assessment_issued.v1',
    );
    expect(rows.length).toBe(4);
    for (const x of rows) {
      expect(Object.keys(x.payload)).toHaveLength(1);
      expect(['practiceAssessmentReviewVersionId', 'skillAssessmentVersionId']).toContain(
        Object.keys(x.payload)[0],
      );
      expect(JSON.stringify(x)).not.toContain(assessmentInput().reason);
    }
    expect(r.view.assessment).not.toBeNull();
    expect(await db.outboxEvent.count()).toBe(0);
  });
  it('sanitizes throwing decision policies and rolls back all attempted rank/review state', async () => {
    const failure = recordAssessment(assessmentInput(), evaluator, {
      ...assessmentOptions,
      canReview: () => {
        throw new Error('private-assessment-policy-marker');
      },
    });
    await expect(failure).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await expect(failure).rejects.not.toThrow('private-assessment-policy-marker');
    expect(await readAssessment()).toBeNull();
  });
  it('passes actual immutable catalog/case/ownership/policy facts to the scoped decision policy', async () => {
    let calls = 0;
    await recordAssessment(assessmentInput(), evaluator, {
      ...assessmentOptions,
      canReview: (scope) => {
        expect(scope).toMatchObject({
          actorAccountId: evaluator.accountId,
          assignmentId: assessmentAssignmentId,
          participantId,
          taxonomyId: catalogId,
          taxonomyReference: { recordId: catalogId, revision: 1 },
          skillId: 'frontend',
          skillDomain: 'web',
          targetRank: 'A',
          ownershipReference: confirmedOwnershipReference,
          currentReviewReference: null,
          currentAssessmentReference: null,
          decision: 'VERIFY',
        });
        expect(scope.policyVersionId).toMatch(/^[a-f0-9-]{36}$/);
        calls++;
        return true;
      },
    });
    expect(calls).toBeGreaterThanOrEqual(2);
  });
  it('serializes actual distinct evaluators on distinct cases/definition-policy locks into one canonical participant-skill result', async () => {
    const first = assessmentInput(),
      second = await secondCase();
    const other = await actor(false, false);
    const grant = await issue(
      { ...grantInput(), evaluatorAccountId: other.accountId, purpose: 'ASSESSMENT_REVIEW' },
      publisher,
      { allowNewWrites: true, canManage: () => true },
    );
    const results = await Promise.allSettled([
      recordAssessment(first),
      recordAssessment({ ...second, assignmentId: grant.assignment.id }, other),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((x) => x.status === 'rejected')).toMatchObject({
      reason: { code: 'REVISION_CHANGED' },
    });
    expect(await db.$queryRawUnsafe('SELECT count(*)::int n FROM "SkillAssessment"')).toEqual([
      { n: 1 },
    ]);
    expect(
      await db.$queryRawUnsafe('SELECT count(*)::int n FROM "PracticeAssessmentReviewVersion"'),
    ).toEqual([{ n: 1 }]);
  }, 10000);
  it('rechecks actual assignment expiry after participant-skill lock wait before decision policy or persisted outcome', async () => {
    assessmentAssignmentId = (
      await issue({
        ...grantInput(),
        purpose: 'ASSESSMENT_REVIEW',
        expiresAt: new Date(Date.now() + 2500).toISOString(),
      })
    ).assignment.id;
    let release!: () => void, locked!: () => void, pidReady!: (id: number) => void;
    const hold = new Promise<void>((r) => (release = r)),
      ready = new Promise<void>((r) => (locked = r)),
      waiting = new Promise<number>((r) => (pidReady = r));
    const blocker = runCommandTransaction(db, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,12022))::text', [
        participantId + ':frontend',
      ]);
      locked();
      await hold;
    });
    await ready;
    let decisions = 0;
    const writing = runCommandTransaction(db, async (tx) => {
      const [r] = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid', []);
      pidReady(r.pid);
      return recordPracticeTrialAssessment(
        tx,
        {
          actor: evaluator,
          input: assessmentInput(),
          idempotencyKey: randomUUID(),
          requestId: 'synthetic-rank-wait',
        },
        {
          ...assessmentOptions,
          canReview: () => {
            decisions++;
            return true;
          },
        },
      );
    }).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    );
    try {
      const pid = await waiting;
      let observed = false;
      for (let i = 0; i < 100; i++) {
        const [r] = await db.$queryRawUnsafe<{ waiting: boolean }[]>(
          "SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",
          pid,
        );
        if (r?.waiting) {
          observed = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(observed).toBe(true);
      await new Promise((r) => setTimeout(r, 2600));
    } finally {
      release();
      await blocker;
    }
    expect(await writing).toMatchObject({ value: null, error: { code: 'RESOURCE_UNAVAILABLE' } });
    expect(decisions).toBe(0);
    expect(await readAssessment()).toBeNull();
  }, 10000);
  type RawPatch = {
    decision?: string;
    criteria?: unknown;
    reason?: string;
    confidence?: string;
    reviewRevision?: number;
    rankRevision?: number;
    assignmentId?: string;
    policyId?: string;
    ownershipId?: string;
    reviewedAt?: string;
    rankState?: string;
    rank?: string;
    rankSample?: number;
    rankConfidence?: string;
    rankPolicy?: string;
    rankReview?: string;
    rankSubmission?: string;
    rankIssuedAt?: string;
    rankReassessmentAt?: string;
    wrongActor?: boolean;
    kind?: string;
    wrongCaseReceipt?: boolean;
    wrongPolicyReceipt?: boolean;
    wrongOwnershipReceipt?: boolean;
    wrongPolicyAccessVersion?: boolean;
    wrongOwnershipAccessVersion?: boolean;
    noCasePointer?: boolean;
    noRankPointer?: boolean;
    noAudit?: boolean;
    wrongReviewPayload?: boolean;
    wrongRankPayload?: boolean;
    reviewOutbox?: boolean;
    rankOutbox?: boolean;
    wrongResult?: boolean;
  };
  async function rawAssessment(patch: RawPatch = {}) {
    const first = await recordAssessment();
    let saved = '';
    await runCommandTransaction(db, (tx) =>
      executeIdempotentCommand(
        tx,
        {
          actorId: patch.wrongActor ? publisher.accountId : evaluator.accountId,
          commandKind: patch.kind ?? 'RecordPracticeTrialAssessment',
          idempotencyKey: randomUUID(),
          requestId: 'synthetic-raw-assessment',
          request: { synthetic: true },
        },
        async ({ receiptId }) => {
          const approved = await lockApprovedPracticeReviewPolicy(
            tx,
            evaluator,
            {
              version: 'v1',
              assignmentId: assessmentAssignmentId,
              submissionId,
              purpose: 'ASSESSMENT_REVIEW',
              expectedPolicyReference: { recordId: assessmentPolicyId, revision: 1 },
            },
            () => true,
          );
          expect(approved).not.toBeNull();
          const evidence = await readPracticeTrialForReview(
            tx,
            evaluator,
            {
              version: 'v1',
              assignmentId: assessmentAssignmentId,
              submissionId,
              purpose: 'ASSESSMENT_REVIEW',
            },
            () => true,
          );
          expect(evidence).not.toBeNull();
          const owned = await readPracticeTrialOwnership(
            tx,
            evaluator,
            {
              version: 'v1',
              assignmentId: assessmentAssignmentId,
              submissionId,
              purpose: 'ASSESSMENT_REVIEW',
            },
            () => true,
          );
          expect(owned).not.toBeNull();
          const [original] = await tx.query<{ definitionVersionId: string }>(
            'SELECT "definitionVersionId"::text FROM "PracticeAssessmentReviewVersion" WHERE "id"=$1::uuid',
            [first.view.review.id],
          );
          const access = async (kind: string, id: string) => {
            const [r] = await tx.query<{ id: string }>(
              'SELECT "id"::text FROM "CommandReceipt" WHERE "actorId"=$1 AND "commandKind"=$2 AND "requestId"=$3',
              [evaluator.accountId, kind, id],
            );
            return r.id;
          };
          const caseReceipt = await access('ReadPracticeTrialForReview', evidence!.accessId),
            policyReceipt = await access('ReadApprovedPracticeReviewPolicy', approved!.accessId),
            ownershipReceipt = await access('ReadPracticeTrialOwnership', owned!.accessId),
            reviewId = randomUUID(),
            rankId = randomUUID(),
            revision = patch.reviewRevision ?? 2,
            rankRevision = patch.rankRevision ?? 2,
            reason = patch.reason ?? 'Synthetic raw manual review.',
            confidence = patch.confidence ?? 'One actual synthetic case.',
            decision = patch.decision ?? 'VERIFY';
          const forgedAccess = async (
            kind: string,
            resultRef: string,
            eventType: string,
            payload: Record<string, string>,
          ) =>
            executeIdempotentCommand(
              tx,
              {
                actorId: evaluator.accountId,
                commandKind: kind,
                idempotencyKey: randomUUID(),
                requestId: randomUUID(),
                request: { synthetic: 'wrong-access-version' },
              },
              async () => ({
                resultRef,
                events: [
                  {
                    type: eventType,
                    aggregateId: submissionId,
                    aggregateVersion: 999,
                    payload,
                    publish: false,
                  },
                ],
              }),
            );
          const actualPolicyReceipt = patch.wrongPolicyAccessVersion
            ? (
                await forgedAccess(
                  'ReadApprovedPracticeReviewPolicy',
                  approved!.policy.id,
                  'skill.practice_review_policy_use_authorized.v1',
                  { practiceReviewPolicyVersionId: approved!.policy.id },
                )
              ).receiptId
            : policyReceipt;
          const actualOwnershipReceipt = patch.wrongOwnershipAccessVersion
            ? (
                await forgedAccess(
                  'ReadPracticeTrialOwnership',
                  owned!.record.id,
                  'skill.practice_trial_ownership_access_authorized.v1',
                  { practiceTrialOwnershipVersionId: owned!.record.id },
                )
              ).receiptId
            : ownershipReceipt;
          const [inserted] = await tx.query<{ reviewedAt: Date }>(
            `INSERT INTO "PracticeAssessmentReviewVersion"("id","submissionId","revision","assignmentId","definitionVersionId","policyVersionId","evaluatorAccountId","decision","reason","confidenceStatement","criteria","reassessmentAt","ownershipVersionId","assessmentVersionId","caseAccessReceiptId","policyAccessReceiptId","ownershipAccessReceiptId","reviewedAt","receiptId","requestId") VALUES($1::uuid,$2::uuid,$3::int,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9,$10,$11::jsonb,NULL,$12::uuid,$13::uuid,$14::uuid,$15::uuid,$16::uuid,COALESCE($17::timestamptz,date_trunc('milliseconds',clock_timestamp())),$18::uuid,$19) RETURNING "reviewedAt"`,
            [
              reviewId,
              submissionId,
              String(revision),
              patch.assignmentId ?? assessmentAssignmentId,
              original.definitionVersionId,
              patch.policyId ?? approved!.policy.id,
              evaluator.accountId,
              decision,
              reason,
              confidence,
              JSON.stringify('criteria' in patch ? patch.criteria : assessmentInput().criteria),
              patch.ownershipId ?? owned!.record.id,
              decision === 'VERIFY' ? rankId : null,
              patch.wrongCaseReceipt ? policyReceipt : caseReceipt,
              patch.wrongPolicyReceipt ? caseReceipt : actualPolicyReceipt,
              patch.wrongOwnershipReceipt ? policyReceipt : actualOwnershipReceipt,
              patch.reviewedAt ?? null,
              receiptId,
              'synthetic-raw-assessment',
            ],
          );
          saved = reviewId;
          if (decision === 'VERIFY') {
            await tx.query(
              `INSERT INTO "SkillAssessmentVersion"("id","assessmentId","participantId","skillId","skillDomain","taxonomyId","revision","state","assessedRank","definitionVersionId","submissionId","ownershipVersionId","policyVersionId","evaluatorAccountId","reviewVersionId","issuedAt","reassessmentAt","confidenceStatement","sampleSize","receiptId","requestId") VALUES($1::uuid,$2::uuid,$3::uuid,'frontend','web',$4,$5::int,$6,$7,$8::uuid,$9::uuid,$10::uuid,$11::uuid,$12,$13::uuid,$14::timestamptz,$15::timestamptz,$16,$17::int,$18::uuid,$19)`,
              [
                rankId,
                first.view.assessment!.reference.recordId,
                participantId,
                catalogId,
                String(rankRevision),
                patch.rankState ?? 'VERIFIED',
                patch.rank ?? 'A',
                original.definitionVersionId,
                patch.rankSubmission ?? submissionId,
                patch.ownershipId ?? owned!.record.id,
                patch.rankPolicy ?? approved!.policy.id,
                evaluator.accountId,
                patch.rankReview ?? reviewId,
                patch.rankIssuedAt ?? inserted.reviewedAt.toISOString(),
                patch.rankReassessmentAt ?? null,
                patch.rankConfidence ?? confidence,
                String(patch.rankSample ?? 1),
                receiptId,
                'synthetic-raw-assessment',
              ],
            );
            if (!patch.noRankPointer)
              await tx.query(
                'UPDATE "SkillAssessment" SET "revision"=$2::int,"currentVersionId"=$3::uuid WHERE "id"=$1::uuid',
                [first.view.assessment!.reference.recordId, String(rankRevision), rankId],
              );
          }
          if (!patch.noCasePointer)
            await tx.query(
              'UPDATE "PracticeAssessmentReview" SET "revision"=$2::int,"currentVersionId"=$3::uuid WHERE "submissionId"=$1::uuid',
              [submissionId, String(revision), reviewId],
            );
          const events: CommandOutcome['events'][number][] = patch.noAudit
            ? [
                {
                  type: 'skill.synthetic_noop.v1',
                  aggregateId: submissionId,
                  aggregateVersion: revision,
                  payload: {},
                  publish: false,
                },
              ]
            : [
                {
                  type: 'skill.practice_assessment_review_recorded.v1',
                  aggregateId: submissionId,
                  aggregateVersion: revision,
                  payload: {
                    practiceAssessmentReviewVersionId: patch.wrongReviewPayload
                      ? randomUUID()
                      : reviewId,
                  },
                  publish: patch.reviewOutbox ?? false,
                },
              ];
          if (decision === 'VERIFY' && !patch.noAudit)
            events.push({
              type: 'skill.assessment_issued.v1',
              aggregateId: first.view.assessment!.reference.recordId,
              aggregateVersion: rankRevision,
              payload: { skillAssessmentVersionId: patch.wrongRankPayload ? randomUUID() : rankId },
              publish: patch.rankOutbox ?? false,
            });
          return { resultRef: patch.wrongResult ? randomUUID() : reviewId, events };
        },
      ),
    );
    return saved;
  }
  it('raw SQL valid control commits exact actual review and rank sources with finalized private audit/projection', async () => {
    const id = await rawAssessment();
    const r = await readAssessment();
    expect(r?.review.id).toBe(id);
    expect(r?.assessment?.reference.revision).toBe(2);
  });
  it.each([
    { decision: 'AUTO_VERIFY' },
    { criteria: null },
    { criteria: [] },
    { criteria: [{ criterionId: 'unknown', result: 'MET', reason: 'Synthetic' }] },
    {
      criteria: fixture.rubric.criteria.map((c) => ({
        criterionId: c.id,
        result: 'UNCERTAIN',
        reason: 'Synthetic',
      })),
    },
    {
      criteria: fixture.rubric.criteria.map((c) => ({
        criterionId: c.id,
        result: 'MET',
        reason: '😀'.repeat(1001),
      })),
    },
    {
      criteria: fixture.rubric.criteria.map((c) => ({
        criterionId: c.id,
        result: 'MET',
        reason: 'Synthetic',
        extra: 'private',
      })),
    },
    { reason: ' ' },
    { reason: ' untrimmed ' },
    { reason: '😀'.repeat(1001) },
    { confidence: ' ' },
    { reviewRevision: 1 },
    { reviewRevision: 3 },
    { rankRevision: 3 },
    { assignmentId: '00000000-0000-4000-8000-000000000000' },
    { policyId: '00000000-0000-4000-8000-000000000000' },
    { ownershipId: '00000000-0000-4000-8000-000000000000' },
    { reviewedAt: '2000-01-01T00:00:00Z' },
    { reviewedAt: '2100-01-01T00:00:00Z' },
    { rankState: 'REVOKED' },
    { rank: 'S' },
    { rank: 'B' },
    { rankSample: 2 },
    { rankConfidence: 'Substituted confidence.' },
    { rankPolicy: '00000000-0000-4000-8000-000000000000' },
    { rankReview: '00000000-0000-4000-8000-000000000000' },
    { rankSubmission: '00000000-0000-4000-8000-000000000000' },
    { rankIssuedAt: '2000-01-01T00:00:00Z' },
    { rankReassessmentAt: '2100-01-01T00:00:00Z' },
    { wrongActor: true },
    { kind: 'WrongKind' },
    { wrongCaseReceipt: true },
    { wrongPolicyReceipt: true },
    { wrongOwnershipReceipt: true },
    { noCasePointer: true },
    { noRankPointer: true },
    { noAudit: true },
    { wrongReviewPayload: true },
    { wrongRankPayload: true },
    { reviewOutbox: true },
    { rankOutbox: true },
    { wrongResult: true },
  ])('raw SQL rejects invalid shape/source/history/clock/private provenance %s', async (patch) => {
    await expect(rawAssessment(patch)).rejects.toBeDefined();
    expect(
      await db.$queryRawUnsafe('SELECT count(*)::int n FROM "PracticeAssessmentReviewVersion"'),
    ).toEqual([{ n: 1 }]);
    expect(
      await db.$queryRawUnsafe('SELECT count(*)::int n FROM "SkillAssessmentVersion"'),
    ).toEqual([{ n: 1 }]);
  });
  it.each(['PracticeAssessmentReviewVersion', 'SkillAssessmentVersion'])(
    'SQL preserves immutable %s even for no-op updates and deletion',
    async (table) => {
      const first = await recordAssessment();
      const id =
        table === 'PracticeAssessmentReviewVersion'
          ? first.view.review.id
          : (
              await db.$queryRawUnsafe<{ id: string }[]>(
                'SELECT "id"::text FROM "SkillAssessmentVersion"',
              )
            )[0].id;
      for (const sql of [
        `UPDATE "${table}" SET "id"="id" WHERE "id"=$1::uuid`,
        `DELETE FROM "${table}" WHERE "id"=$1::uuid`,
      ])
        await expect(db.$executeRawUnsafe(sql, id)).rejects.toBeDefined();
      expect((await readAssessment())?.assessment).toEqual(first.view.assessment);
    },
  );
  it('cannot delete or rewind either canonical review or participant-skill pointer', async () => {
    const first = await recordAssessment();
    await recordAssessment({
      ...assessmentInput(),
      expectedReviewReference: first.view.review.reference,
      expectedAssessmentReference: first.view.assessment!.reference,
    });
    await expect(
      db.$executeRawUnsafe(
        'DELETE FROM "PracticeAssessmentReview" WHERE "submissionId"=$1::uuid',
        submissionId,
      ),
    ).rejects.toBeDefined();
    await expect(
      db.$executeRawUnsafe(
        'DELETE FROM "SkillAssessment" WHERE "id"=$1::uuid',
        first.view.assessment!.reference.recordId,
      ),
    ).rejects.toBeDefined();
    await expect(
      db.$executeRawUnsafe(
        'UPDATE "PracticeAssessmentReview" SET "revision"=1,"currentVersionId"=$2::uuid WHERE "submissionId"=$1::uuid',
        submissionId,
        first.view.review.id,
      ),
    ).rejects.toBeDefined();
    const [old] = await db.$queryRawUnsafe<{ id: string }[]>(
      'SELECT "id"::text FROM "SkillAssessmentVersion" WHERE "revision"=1',
    );
    await expect(
      db.$executeRawUnsafe(
        'UPDATE "SkillAssessment" SET "revision"=1,"currentVersionId"=$2::uuid WHERE "id"=$1::uuid',
        first.view.assessment!.reference.recordId,
        old.id,
      ),
    ).rejects.toBeDefined();
    expect((await readAssessment())?.assessment?.reference.revision).toBe(2);
  });
  it.each(['policy', 'ownership'])(
    'raw SQL requires exact %s private-access audit version, not an identifier-only forged trace',
    async (which) => {
      await expect(
        rawAssessment(
          which === 'policy'
            ? { wrongPolicyAccessVersion: true }
            : { wrongOwnershipAccessVersion: true },
        ),
      ).rejects.toBeDefined();
      expect(
        await db.$queryRawUnsafe('SELECT count(*)::int n FROM "PracticeAssessmentReviewVersion"'),
      ).toEqual([{ n: 1 }]);
    },
  );
  it('accepts the actual dynamic ownership access revision after a new confirmed finding rather than hardcoding revision one', async () => {
    const current = await recordOwnership({
      ...ownershipInput(),
      expectedOwnershipReference: confirmedOwnershipReference,
    });
    expect(current.view.record.reference.revision).toBe(2);
    const r = await recordAssessment({
      ...assessmentInput(),
      expectedOwnershipReference: current.view.record.reference,
    });
    expect(r.view.assessment?.state).toBe('VERIFIED');
    expect(r.view.review.ownershipReference).toEqual(current.view.record.reference);
  });
  it('accepts a later actual approved policy revision while its access audit still targets immutable submission revision one', async () => {
    const p = await publishPolicy({
      ...policyInput(),
      policyId: assessmentPolicyId,
      purpose: 'ASSESSMENT_REVIEW',
      expectedRevision: 1,
      guidance: 'Synthetic updated assessment guidance, original rubric unchanged.',
    });
    const r = await recordAssessment({
      ...assessmentInput(),
      expectedPolicyReference: p.policy.reference,
    });
    expect(r.view.review.policyReference.revision).toBe(2);
    expect(r.view.assessment?.assessmentPolicyVersion).toBe(p.policy.id);
  });
  it.each(['missing', 'foreign', 'past'])(
    'rejects structurally inconsistent %s current assessment pointers in the reusable private view contract',
    async (change) => {
      const r = await recordAssessment();
      let value: unknown;
      if (change === 'missing')
        value = { ...r.view, currentAssessmentReference: null, isCurrentAssessment: false };
      else if (change === 'foreign')
        value = {
          ...r.view,
          currentAssessmentReference: { recordId: randomUUID(), revision: 1 },
          isCurrentAssessment: false,
        };
      else
        value = {
          ...r.view,
          review: {
            ...r.view.review,
            assessmentReference: { ...r.view.assessment!.reference, revision: 2 },
          },
          assessment: {
            ...r.view.assessment!,
            reference: { ...r.view.assessment!.reference, revision: 2 },
          },
          isCurrentAssessment: false,
        };
      expect(PracticeTrialAssessmentViewSchema.safeParse(value).success).toBe(false);
    },
  );
  it('observes current case and participant-skill references for a newly assigned case without guessing an existing assessment or reading another case private fields', async () => {
    const first = await recordAssessment();
    const body = await secondCase();
    const other = await actor(false, false);
    const grant = await issue(
      { ...grantInput(), evaluatorAccountId: other.accountId, purpose: 'ASSESSMENT_REVIEW' },
      publisher,
      { allowNewWrites: true, canManage: () => true },
    );
    let privateRankQueries = 0;
    const ctx = await runCommandTransaction(db, (tx) =>
      observePracticeTrialAssessmentContext(
        {
          ...tx,
          async query<Row>(sql: string, bindings: readonly (string | null)[]) {
            if (
              sql.includes('"confidenceStatement"') ||
              sql.includes('"answer"') ||
              sql.includes('"explanation"')
            )
              privateRankQueries++;
            return tx.query<Row>(sql, bindings);
          },
        },
        other,
        { version: 'v1', assignmentId: grant.assignment.id, submissionId },
        () => true,
      ),
    );
    expect(ctx).toMatchObject({
      version: 'v1',
      private: true,
      submissionReference: { recordId: submissionId, revision: 1 },
      definitionReference: { recordId: trialId, revision: 2 },
      rubricReference: body.expectedRubricReference,
      currentOwnershipReference: body.expectedOwnershipReference,
      currentReviewReference: null,
      currentAssessmentReference: first.view.assessment!.reference,
      isAuthorizationToken: false,
      verifiesSkill: false,
    });
    expect(privateRankQueries).toBe(0);
    const r = await recordAssessment(
      {
        ...body,
        assignmentId: grant.assignment.id,
        expectedAssessmentReference: ctx!.currentAssessmentReference,
      },
      other,
    );
    expect(r.view.assessment?.reference.revision).toBe(2);
  }, 10000);
  it('observes empty review/rank refs before the first review while retaining actual confirmed ownership and no rank authority', async () => {
    const ctx = await runCommandTransaction(db, (tx) =>
      observePracticeTrialAssessmentContext(
        tx,
        evaluator,
        { version: 'v1', assignmentId: assessmentAssignmentId, submissionId },
        () => true,
      ),
    );
    expect(ctx).toMatchObject({
      currentReviewReference: null,
      currentAssessmentReference: null,
      currentOwnershipReference: confirmedOwnershipReference,
      verifiesSkill: false,
      isAuthorizationToken: false,
      createsPermissionGrant: false,
      consumesCapacity: false,
    });
  });
  it('does not return context metadata to admin/claimant/wrong-purpose appointments or when current read scope denies', async () => {
    for (const a of [publisher, subject])
      expect(
        await runCommandTransaction(db, (tx) =>
          observePracticeTrialAssessmentContext(
            tx,
            a,
            { version: 'v1', assignmentId: assessmentAssignmentId, submissionId },
            () => true,
          ),
        ),
      ).toBeNull();
    expect(
      await runCommandTransaction(db, (tx) =>
        observePracticeTrialAssessmentContext(
          tx,
          evaluator,
          { version: 'v1', assignmentId, submissionId },
          () => true,
        ),
      ),
    ).toBeNull();
    expect(
      await runCommandTransaction(db, (tx) =>
        observePracticeTrialAssessmentContext(
          tx,
          evaluator,
          { version: 'v1', assignmentId: assessmentAssignmentId, submissionId },
          () => false,
        ),
      ),
    ).toBeNull();
  });
  it('audits initial context access before global current assessment metadata and fails closed without a forged empty current ref', async () => {
    let queried = false;
    const run = (bad: boolean) =>
      runCommandTransaction(db, (tx) =>
        observePracticeTrialAssessmentContext(
          {
            ...tx,
            async query<Row>(sql: string, bindings: readonly (string | null)[]) {
              if (bad && sql.includes('INSERT INTO "AuditEvent"'))
                throw new Error('private-context-audit-marker');
              if (sql.includes('FROM "SkillAssessment" WHERE')) {
                const [e] = await tx.query<{ n: number }>(
                  'SELECT count(*)::int n FROM "AuditEvent" WHERE "eventType"=$1',
                  ['skill.practice_assessment_context_access_authorized.v1'],
                );
                expect(e.n).toBeGreaterThanOrEqual(1);
                queried = true;
              }
              return tx.query<Row>(sql, bindings);
            },
          },
          evaluator,
          { version: 'v1', assignmentId: assessmentAssignmentId, submissionId },
          () => true,
        ),
      );
    expect((await run(false))?.private).toBe(true);
    expect(queried).toBe(true);
    queried = false;
    const failure = run(true);
    await expect(failure).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await expect(failure).rejects.not.toThrow('private-context-audit-marker');
    expect(queried).toBe(false);
  });
  it('drops context if current scope closes during its metadata query', async () => {
    let enabled = true;
    const r = await runCommandTransaction(db, (tx) =>
      observePracticeTrialAssessmentContext(
        {
          ...tx,
          async query<Row>(sql: string, bindings: readonly (string | null)[]) {
            const rows = await tx.query<Row>(sql, bindings);
            if (sql.includes('FROM "SkillAssessment" WHERE')) enabled = false;
            return rows;
          },
        },
        evaluator,
        { version: 'v1', assignmentId: assessmentAssignmentId, submissionId },
        () => enabled,
      ),
    );
    expect(r).toBeNull();
  });
});
