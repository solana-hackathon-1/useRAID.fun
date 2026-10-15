import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/lib/db';
import { hash } from '../src/lib/auth-primitives';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
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
import {
  PracticeAssessmentDecisionViewSchema,
  recordPracticeAssessmentDecision,
  readPracticeTrialAssessmentState,
} from '../src/skills/practice-trial-assessment-storage';
let issued: Awaited<ReturnType<typeof recordAssessment>>;
const decisionOptions = {
  allowNewWrites: true,
  canRead: () => true,
  canUsePolicy: () => true,
  canDecide: () => true,
};
const decisionInput = (action = 'REQUIRE_REASSESSMENT') => ({
  version: 'v1',
  assignmentId: assessmentAssignmentId,
  submissionId,
  expectedAssessmentReference: issued.view.assessment!.reference,
  expectedReviewReference: issued.view.review.reference,
  expectedOwnershipReference: confirmedOwnershipReference,
  expectedPolicyReference: { recordId: assessmentPolicyId, revision: 1 },
  action,
  reasonCategory: action === 'REVOKE' ? 'FRAUDULENT_ASSESSMENT_EVIDENCE' : 'CAPABILITY_RECHECK',
  reason: 'Synthetic authorized reasoned original-case decision.',
  findings: [
    {
      kind: action === 'REVOKE' ? 'ASSESSMENT_EVIDENCE' : 'CAPABILITY_EVIDENCE',
      detail: 'Specific synthetic original-case observation; no automatic inference from a signal.',
    },
  ],
  dueAt: action === 'REVOKE' ? null : new Date(Date.now() + 3600000).toISOString(),
});
const decide = (
  body: unknown = decisionInput(),
  a = evaluator,
  options = decisionOptions,
  key = randomUUID(),
) =>
  runCommandTransaction(db, (tx) =>
    recordPracticeAssessmentDecision(
      tx,
      { actor: a, input: body, idempotencyKey: key, requestId: 'synthetic-assessment-decision' },
      options,
    ),
  );
const readState = (
  revision: number | undefined = undefined,
  a = evaluator,
  id = assessmentAssignmentId,
  canRead = decisionOptions.canRead,
) =>
  runCommandTransaction(db, (tx) =>
    readPracticeTrialAssessmentState(
      tx,
      a,
      { version: 'v1', assignmentId: id, submissionId, revision },
      canRead,
    ),
  );
integration('T013D6 actual reasoned assessment state decisions', () => {
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
    issued = await recordAssessment();
  });
  afterAll(() => db.$disconnect());

  it('commits capability recheck with actual source history, preserving original rank/evidence/issuer and declaring it no longer current verified', async () => {
    const r = await decide();
    expect(r.status).toBe('EXECUTED');
    expect(r.view.decision).toMatchObject({
      action: 'REQUIRE_REASSESSMENT',
      reasonCategory: 'CAPABILITY_RECHECK',
      priorAssessmentReference: issued.view.assessment!.reference,
      evaluatorAccountId: evaluator.accountId,
      persisted: true,
    });
    expect(r.view.assessment).toMatchObject({
      state: 'REASSESSMENT_REQUIRED',
      assessedRank: 'A',
      sampleSize: 1,
      reference: { recordId: issued.view.assessment!.reference.recordId, revision: 2 },
      evidenceReferences: issued.view.assessment!.evidenceReferences,
    });
    expect(r.view.priorAssessment).toEqual(issued.view.assessment);
    expect(r.view.isCurrent).toBe(true);
    expect((await readAssessment())!.isCurrentAssessment).toBe(false);
    expect((await readAssessment())!.assessment).toEqual(issued.view.assessment);
    expect((await readState())!.assessment.state).toBe('REASSESSMENT_REQUIRED');
    expect((await readState(1))!.isCurrent).toBe(false);
    const events = await db.auditEvent.findMany({
      where: { eventType: 'skill.assessment_reassessment_required.v1' },
    });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ practiceAssessmentDecisionId: r.view.decision.id });
    expect(await db.outboxEvent.count({ where: { eventId: events[0].id } })).toBe(0);
  });
  it('commits separate reasoned fraud revocation without account/reputation/capacity/money changes or rewriting original declaration', async () => {
    const r = await decide(decisionInput('REVOKE'));
    expect(r.view.assessment.state).toBe('REVOKED');
    expect(r.view.assessment.reassessmentAt).toBeNull();
    expect(r.view.decision.reasonCategory).toBe('FRAUDULENT_ASSESSMENT_EVIDENCE');
    expect(await db.user.findUniqueOrThrow({ where: { id: subject.accountId } })).toMatchObject({
      suspended: false,
    });
    expect(
      (
        await runCommandTransaction(db, (tx) =>
          readPracticeTrialSubmission(tx, subject, submissionId),
        )
      )?.ownership,
    ).toBe('UNCONFIRMED');
  });
  it('retries original result after writes off, policy withdrawal and later correction; changed input conflicts', async () => {
    const key = randomUUID(),
      body = decisionInput(),
      a = await decide(body, evaluator, decisionOptions, key);
    await decide({
      ...decisionInput('REVOKE'),
      expectedAssessmentReference: a.view.assessment.reference,
    });
    await publishPolicy({
      ...policyInput(),
      policyId: assessmentPolicyId,
      purpose: 'ASSESSMENT_REVIEW',
      expectedRevision: 1,
      state: 'WITHDRAWN',
    });
    const replay = await decide(
      body,
      evaluator,
      {
        ...decisionOptions,
        allowNewWrites: false,
        canUsePolicy: () => false,
        canDecide: () => false,
      },
      key,
    );
    expect(replay.status).toBe('REPLAYED');
    expect(replay.view.decision).toEqual(a.view.decision);
    expect(replay.view.isCurrent).toBe(false);
    expect(replay.view.assessment.state).toBe('REASSESSMENT_REQUIRED');
    await expect(
      decide({ ...body, reason: 'Changed' }, evaluator, decisionOptions, key),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });
  it.each([
    'WRONG_PURPOSE',
    'FOREIGN_ACTOR',
    'REVOKED',
    'READ_POLICY',
    'DECISION_POLICY',
    'WRITE_OFF',
    'SESSION_REVOKED',
    'SUSPENDED',
    'POLICY_WITHDRAWN',
    'POLICY_STALE',
    'ASSESSMENT_STALE',
    'REVIEW_STALE',
    'OWNERSHIP_STALE',
  ])('fails closed for %s without a state change', async (kind) => {
    const body = decisionInput();
    let a = evaluator,
      o = decisionOptions,
      code = 'RESOURCE_UNAVAILABLE';
    if (kind === 'WRONG_PURPOSE') body.assignmentId = assignmentId;
    if (kind === 'FOREIGN_ACTOR') a = await actor(false, false);
    if (kind === 'REVOKED') await revoke(assessmentAssignmentId);
    if (kind === 'READ_POLICY') o = { ...o, canRead: () => false };
    if (kind === 'DECISION_POLICY') o = { ...o, canDecide: () => false };
    if (kind === 'WRITE_OFF') {
      o = { ...o, allowNewWrites: false };
      code = 'WRITES_DISABLED';
    }
    if (kind === 'SESSION_REVOKED')
      await db.session.deleteMany({ where: { tokenHash: evaluator.sessionHash } });
    if (kind === 'SUSPENDED')
      await db.user.update({ where: { id: evaluator.accountId }, data: { suspended: true } });
    if (kind === 'POLICY_WITHDRAWN') body.expectedPolicyReference.revision = 2;
    if (kind === 'POLICY_WITHDRAWN')
      await publishPolicy({
        ...policyInput(),
        policyId: assessmentPolicyId,
        purpose: 'ASSESSMENT_REVIEW',
        expectedRevision: 1,
        state: 'WITHDRAWN',
      });
    if (kind.endsWith('_STALE')) {
      code = 'REVISION_CHANGED';
      if (kind === 'POLICY_STALE') body.expectedPolicyReference.revision = 9;
      if (kind === 'ASSESSMENT_STALE')
        body.expectedAssessmentReference = { ...body.expectedAssessmentReference, revision: 9 };
      if (kind === 'REVIEW_STALE')
        body.expectedReviewReference = { ...body.expectedReviewReference, revision: 9 };
      if (kind === 'OWNERSHIP_STALE')
        body.expectedOwnershipReference = { ...body.expectedOwnershipReference, revision: 9 };
    }
    await expect(decide(body, a, o)).rejects.toMatchObject({
      code:
        kind === 'SESSION_REVOKED'
          ? 'AUTHENTICATION_REQUIRED'
          : kind === 'SUSPENDED'
            ? 'ACCOUNT_RESTRICTED'
            : code,
    });
    expect(
      (
        await db.$queryRawUnsafe<{ revision: number }[]>('SELECT "revision" FROM "SkillAssessment"')
      )[0].revision,
    ).toBe(1);
  });
  it.each([
    { reason: '' },
    { reason: '😀'.repeat(1001) },
    { reason: 'bad\u0000value' },
    { action: 'REQUIRE_REASSESSMENT', reasonCategory: 'FRAUDULENT_ASSESSMENT_EVIDENCE' },
    { action: 'REVOKE', reasonCategory: 'CAPABILITY_RECHECK' },
    { dueAt: null },
    { dueAt: '2020-01-01T00:00:00.000Z' },
    { findings: [] },
    { findings: [{ kind: 'NETWORK_SIGNAL', detail: 'Shared IP' }] },
    { rank: 'S' },
    { sampleSize: 200 },
  ])('rejects invalid decision input before effect %j', async (patch) => {
    await expect(decide({ ...decisionInput(), ...patch })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
  it('real concurrent decisions from one exact revision produce one effect', async () => {
    const body = decisionInput();
    const r = await Promise.allSettled([decide(body), decide(body)]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(r.filter((x) => x.status === 'rejected')).toHaveLength(1);
    expect(
      await db.auditEvent.count({
        where: { eventType: 'skill.assessment_reassessment_required.v1' },
      }),
    ).toBe(1);
  });
  it('requires a current actual same-case grant for historical state, with private audit before snapshot selection', async () => {
    const r = await readState();
    expect(r!.assessment).toEqual(issued.view.assessment);
    expect(r!.isCurrent).toBe(true);
    expect(r!.accessId).toMatch(/^[0-9a-f-]{36}$/);
    await revoke(assessmentAssignmentId);
    expect(await readState()).toBeNull();
  });
  it('requires supported state transitions and ordinary new verification for restoration', async () => {
    const first = await decide();
    await expect(
      decide({ ...decisionInput(), expectedAssessmentReference: first.view.assessment.reference }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const last = await decide({
      ...decisionInput('REVOKE'),
      expectedAssessmentReference: first.view.assessment.reference,
    });
    await expect(
      decide({
        ...decisionInput('REVOKE'),
        expectedAssessmentReference: last.view.assessment.reference,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const restored = await recordAssessment({
      ...assessmentInput(),
      expectedReviewReference: issued.view.review.reference,
      expectedAssessmentReference: last.view.assessment.reference,
    });
    expect(restored.view.assessment).toMatchObject({
      state: 'VERIFIED',
      sampleSize: 1,
      reference: { recordId: last.view.assessment.reference.recordId, revision: 4 },
    });
    expect((await readState(1))!.assessment).toEqual(issued.view.assessment);
  });
  it('uses actual later approved policy, nonverification review and ownership finding revisions without rewriting original lineage', async () => {
    await publishPolicy({
      ...policyInput(),
      policyId: assessmentPolicyId,
      purpose: 'ASSESSMENT_REVIEW',
      expectedRevision: 1,
    });
    const review = await recordAssessment({
      ...assessmentInput(),
      decision: 'MORE_EVIDENCE',
      expectedReviewReference: issued.view.review.reference,
      expectedAssessmentReference: issued.view.assessment!.reference,
      expectedPolicyReference: { recordId: assessmentPolicyId, revision: 2 },
    });
    const own = await recordOwnership({
      ...ownershipInput(),
      expectedOwnershipReference: confirmedOwnershipReference,
      decision: 'DISPUTE',
    });
    const r = await decide({
      ...decisionInput('REVOKE'),
      expectedPolicyReference: { recordId: assessmentPolicyId, revision: 2 },
      expectedReviewReference: review.view.review.reference,
      expectedOwnershipReference: own.view.record.reference,
    });
    expect(r.view.decision.caseReviewReference.revision).toBe(2);
    expect(r.view.decision.ownershipReference.revision).toBe(2);
    expect(r.view.decision.policyReference.revision).toBe(2);
    expect(r.view.priorAssessment).toEqual(issued.view.assessment);
    expect(r.view.assessment.sampleSize).toBe(1);
  });
  it('old-case authority cannot change or read a newer different-case current assessment', async () => {
    const old = decisionInput(),
      oldSubmission = submissionId,
      oldAssignment = assessmentAssignmentId;
    startId = (await begin()).start.id;
    submissionId = (await submit()).submission.reference.recordId;
    assignmentId = (await issue()).assignment.id;
    confirmedOwnershipReference = (await recordOwnership()).view.record.reference;
    assessmentAssignmentId = (await issue({ ...grantInput(), purpose: 'ASSESSMENT_REVIEW' }))
      .assignment.id;
    const second = await recordAssessment({
      ...assessmentInput(),
      expectedAssessmentReference: issued.view.assessment!.reference,
    });
    await expect(
      decide({ ...old, expectedAssessmentReference: second.view.assessment!.reference }),
    ).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
    submissionId = oldSubmission;
    assessmentAssignmentId = oldAssignment;
    expect(await readState()).toBeNull();
    expect((await readState(1))!.assessment).toEqual(issued.view.assessment);
  });
  it('audits private current-state access before snapshot columns and returns no snapshot if scope closes during selection', async () => {
    let enabled = true,
      audited = false,
      selected = false;
    const view = await runCommandTransaction(db, (tx) =>
      readPracticeTrialAssessmentState(
        {
          ...tx,
          async query<Row>(sql: string, b: readonly (string | null)[]) {
            if (sql.includes('v."assessedRank",d."definition"')) {
              expect(audited).toBe(true);
              selected = true;
            }
            const rows = await tx.query<Row>(sql, b);
            if (
              sql.includes('INSERT INTO "AuditEvent"') &&
              b[3] === 'skill.assessment_state_access_authorized.v1'
            )
              audited = true;
            if (selected) enabled = false;
            return rows;
          },
        },
        evaluator,
        { version: 'v1', assignmentId: assessmentAssignmentId, submissionId },
        () => enabled,
      ),
    );
    expect(audited && selected).toBe(true);
    expect(view).toBeNull();
  });
  it.each(['READ', 'POLICY', 'DECISION'])(
    'rolls back if final %s authority closes during private result selection',
    async (kind) => {
      let enabled = true,
        triggered = false;
      const failure = runCommandTransaction(db, (tx) =>
        recordPracticeAssessmentDecision(
          {
            ...tx,
            async query<Row>(sql: string, b: readonly (string | null)[]) {
              const rows = await tx.query<Row>(sql, b);
              if (sql.startsWith('SELECT d.*,r.')) {
                enabled = false;
                triggered = true;
              }
              return rows;
            },
          },
          {
            actor: evaluator,
            input: decisionInput(),
            idempotencyKey: randomUUID(),
            requestId: 'synthetic-final-decision',
          },
          {
            allowNewWrites: true,
            canRead: () => kind !== 'READ' || enabled,
            canUsePolicy: () => kind !== 'POLICY' || enabled,
            canDecide: () => kind !== 'DECISION' || enabled,
          },
        ),
      );
      await expect(failure).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
      expect(triggered).toBe(true);
      expect((await readState())!.assessment.state).toBe('VERIFIED');
    },
  );
  it('sanitizes throwing scoped policies without persisting a decision or private exception', async () => {
    const failure = decide(decisionInput(), evaluator, {
      ...decisionOptions,
      canDecide: () => {
        throw Error('private-decision-marker');
      },
    });
    await expect(failure).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await expect(failure).rejects.not.toThrow('private-decision-marker');
    expect((await readState())!.assessment.state).toBe('VERIFIED');
  });
  const rawVariants = [
    'VALID',
    'REASON_EMPTY',
    'REASON_UTF16',
    'FINDINGS_NULL_KIND',
    'FINDINGS_EXTRA',
    'FINDINGS_SIGNAL',
    'WRONG_CATEGORY',
    'PAST_DUE',
    'MISSING_DUE',
    'FAMILY',
    'PRIOR',
    'RESULT',
    'REVIEW',
    'OWNERSHIP',
    'ASSIGNMENT',
    'POLICY',
    'ACTOR',
    'CASE_ACCESS',
    'POLICY_ACCESS',
    'REVIEW_ACCESS',
    'OWNERSHIP_ACCESS',
    'PRIOR_ACCESS',
    'COMMAND_RECEIPT',
    'REQUEST',
    'VERSION_STATE',
    'VERSION_RANK',
    'VERSION_SAMPLE',
    'VERSION_CONFIDENCE',
    'VERSION_REVIEW',
    'VERSION_SUBMISSION',
    'VERSION_POLICY',
    'VERSION_ACTOR',
    'VERSION_TIME',
    'VERSION_DECISION',
    'NO_POINTER',
    'CASE_ACCESS_REVISION',
    'POLICY_ACCESS_REVISION',
    'REVIEW_ACCESS_REVISION',
    'OWNERSHIP_ACCESS_REVISION',
    'PRIOR_ACCESS_REVISION',
    'CASE_EVENT_VERSION',
    'STATE_EVENT_VERSION',
    'CASE_EVENT_PAYLOAD',
    'STATE_EVENT_PAYLOAD',
    'CASE_OUTBOX',
    'STATE_OUTBOX',
  ];
  it.each(rawVariants)(
    'database guard independently validates raw provenance/control %s',
    async (variant) => {
      let mutated = variant === 'VALID';
      const running = runCommandTransaction(db, (tx) =>
        recordPracticeAssessmentDecision(
          {
            ...tx,
            async query<Row>(original: string, bindings: readonly (string | null)[]) {
              let sql = original;
              const b = [...bindings];
              if (sql.startsWith('INSERT INTO "PracticeAssessmentDecision"')) {
                const map: Record<string, [number, string | null]> = {
                  REASON_EMPTY: [11, ''],
                  REASON_UTF16: [11, '😀'.repeat(1001)],
                  FINDINGS_NULL_KIND: [12, JSON.stringify([{ kind: null, detail: 'x' }])],
                  FINDINGS_EXTRA: [
                    12,
                    JSON.stringify([{ kind: 'CAPABILITY_EVIDENCE', detail: 'x', approved: true }]),
                  ],
                  FINDINGS_SIGNAL: [
                    12,
                    JSON.stringify([{ kind: 'NETWORK_SIGNAL', detail: 'sharedIP' }]),
                  ],
                  WRONG_CATEGORY: [10, 'FRAUDULENT_ASSESSMENT_EVIDENCE'],
                  PAST_DUE: [13, '2020-01-01T00:00:00.000Z'],
                  MISSING_DUE: [13, null],
                  FAMILY: [1, randomUUID()],
                  PRIOR: [2, randomUUID()],
                  RESULT: [3, randomUUID()],
                  REVIEW: [4, randomUUID()],
                  OWNERSHIP: [5, randomUUID()],
                  ASSIGNMENT: [6, assignmentId],
                  POLICY: [7, randomUUID()],
                  ACTOR: [8, publisher.accountId],
                  CASE_ACCESS: [14, b[15]],
                  POLICY_ACCESS: [15, b[14]],
                  REVIEW_ACCESS: [16, b[14]],
                  OWNERSHIP_ACCESS: [17, b[14]],
                  PRIOR_ACCESS: [18, b[14]],
                  COMMAND_RECEIPT: [19, b[14]],
                  REQUEST: [20, 'foreign-request'],
                };
                if (map[variant]) {
                  const [i, value] = map[variant];
                  b[i] = value;
                  mutated = true;
                }
              }
              if (sql.startsWith('INSERT INTO "SkillAssessmentVersion"')) {
                const map: Record<string, [string, string]> = {
                  VERSION_STATE: [
                    "CASE WHEN d.\"action\"='REVOKE' THEN 'REVOKED' ELSE 'REASSESSMENT_REQUIRED' END",
                    "'VERIFIED'",
                  ],
                  VERSION_RANK: ['p."assessedRank"', "'S'"],
                  VERSION_SAMPLE: ['p."sampleSize"', '9'],
                  VERSION_CONFIDENCE: ['p."confidenceStatement"', "'changed original confidence'"],
                  VERSION_REVIEW: ['p."reviewVersionId"', "'" + randomUUID() + "'::uuid"],
                  VERSION_SUBMISSION: ['p."submissionId"', "'" + randomUUID() + "'::uuid"],
                  VERSION_POLICY: ['d."policyVersionId"', "'" + randomUUID() + "'::uuid"],
                  VERSION_ACTOR: ['d."evaluatorAccountId"', "'" + publisher.accountId + "'"],
                  VERSION_TIME: ['d."decidedAt"', 'd."decidedAt"+interval \'1 second\''],
                  VERSION_DECISION: ['d."id" FROM', 'NULL FROM'],
                };
                if (map[variant]) {
                  const [a, v] = map[variant];
                  expect(sql).toContain(a);
                  sql = sql.replace(a, v);
                  mutated = true;
                }
              }
              if (variant === 'NO_POINTER' && sql.startsWith('UPDATE "SkillAssessment"')) {
                mutated = true;
                return tx.query<Row>('SELECT $1::text AS id', [b[0]]);
              }
              if (sql.includes('INSERT INTO "AuditEvent"')) {
                const access: Record<string, string> = {
                  CASE_ACCESS_REVISION: 'skill.practice_review_access_authorized.v1',
                  POLICY_ACCESS_REVISION: 'skill.practice_review_policy_use_authorized.v1',
                  REVIEW_ACCESS_REVISION: 'skill.practice_assessment_review_access_authorized.v1',
                  OWNERSHIP_ACCESS_REVISION: 'skill.practice_trial_ownership_access_authorized.v1',
                  PRIOR_ACCESS_REVISION: 'skill.assessment_state_access_authorized.v1',
                };
                if (access[variant] === b[3]) {
                  b[5] = '999';
                  mutated = true;
                }
                const isCase = b[3] === 'skill.assessment_decision_recorded.v1',
                  isState = b[3] === 'skill.assessment_reassessment_required.v1';
                if (
                  (variant === 'CASE_EVENT_VERSION' && isCase) ||
                  (variant === 'STATE_EVENT_VERSION' && isState)
                ) {
                  b[5] = '999';
                  mutated = true;
                }
                if (
                  (variant === 'CASE_EVENT_PAYLOAD' && isCase) ||
                  (variant === 'STATE_EVENT_PAYLOAD' && isState)
                ) {
                  b[9] = JSON.stringify({ practiceAssessmentDecisionId: randomUUID() });
                  mutated = true;
                }
                if (
                  (variant === 'CASE_OUTBOX' && isCase) ||
                  (variant === 'STATE_OUTBOX' && isState)
                ) {
                  const rows = await tx.query<{ id: string }>(sql, b);
                  await tx.query('INSERT INTO "OutboxEvent"("eventId") VALUES($1::uuid)', [
                    rows[0].id,
                  ]);
                  mutated = true;
                  return rows as Row[];
                }
              }
              return tx.query<Row>(sql, b);
            },
          },
          {
            actor: evaluator,
            input: decisionInput(),
            idempotencyKey: randomUUID(),
            requestId: 'synthetic-raw-decision',
          },
          decisionOptions,
        ),
      );
      if (variant === 'VALID') {
        expect((await running).view.assessment.state).toBe('REASSESSMENT_REQUIRED');
      } else {
        await expect(running).rejects.toBeDefined();
        expect((await readState())!.assessment.state).toBe('VERIFIED');
      }
      expect(mutated).toBe(true);
    },
  );
  it('immutable cases and committed versions reject update/delete; current pointers cannot rewind', async () => {
    const r = await decide();
    for (const table of ['PracticeAssessmentDecision', 'SkillAssessmentVersion']) {
      const id =
        table === 'PracticeAssessmentDecision'
          ? r.view.decision.id
          : (await readState())!.assessmentVersionId;
      await expect(
        db.$executeRawUnsafe(`UPDATE "${table}" SET "requestId"='changed' WHERE "id"=$1::uuid`, id),
      ).rejects.toBeDefined();
      await expect(
        db.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "id"=$1::uuid`, id),
      ).rejects.toBeDefined();
    }
    await expect(
      db.$executeRawUnsafe(
        'UPDATE "SkillAssessment" SET "revision"=1 WHERE "id"=$1::uuid',
        r.view.assessment.reference.recordId,
      ),
    ).rejects.toBeDefined();
  });

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
      return recordPracticeAssessmentDecision(
        tx,
        {
          actor: evaluator,
          input: decisionInput(),
          idempotencyKey: randomUUID(),
          requestId: 'synthetic-rank-wait',
        },
        {
          ...decisionOptions,
          canDecide: () => {
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
    expect(
      (
        await db.$queryRawUnsafe<{ revision: number }[]>('SELECT "revision" FROM "SkillAssessment"')
      )[0].revision,
    ).toBe(1);
  }, 10000);
  it.each(['UNSUPPORTED_FINDINGS', 'FOREIGN_DEFINITION', 'FOREIGN_EVIDENCE', 'REVOKED_PRIOR'])(
    'rejects inconsistent reusable decision-view provenance %s',
    async (kind) => {
      const r = await decide();
      expect(PracticeAssessmentDecisionViewSchema.safeParse(r.view).success).toBe(true);
      const view = {
        ...r.view,
        decision: { ...r.view.decision },
        assessment: { ...r.view.assessment },
        priorAssessment: { ...r.view.priorAssessment },
      };
      if (kind === 'UNSUPPORTED_FINDINGS')
        view.decision.findings = [
          { kind: 'ASSESSMENT_EVIDENCE', detail: 'This is not a capability recheck finding.' },
        ];
      if (kind === 'FOREIGN_DEFINITION')
        view.assessment.definitionReference = { recordId: 'foreign-definition', revision: 1 };
      if (kind === 'FOREIGN_EVIDENCE')
        view.assessment.evidenceReferences = [{ recordId: 'foreign-evidence', revision: 1 }];
      if (kind === 'REVOKED_PRIOR') view.priorAssessment.state = 'REVOKED';
      expect(PracticeAssessmentDecisionViewSchema.safeParse(view).success).toBe(false);
    },
  );
});
