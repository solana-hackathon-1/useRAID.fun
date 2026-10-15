import type { CommandReceiptTransaction } from '../src/command-receipts';
import { saveSkillClaim } from '../src/skills/claim-storage';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/lib/db';
import { hash } from '../src/lib/auth-primitives';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { publishSkillTaxonomy, type SkillTaxonomyActor } from '../src/skills/taxonomy-storage';
import { publishPracticeTrialDefinition } from '../src/skills/practice-trial-storage';
import { startPracticeTrial } from '../src/skills/practice-trial-attempt-storage';
import { submitPracticeTrial } from '../src/skills/practice-trial-submission-storage';
import {
  issuePracticeReviewAssignment,
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
import { readOwnSkillAssessment } from '../src/skills/own-assessment-storage';
import { recordPracticeAssessmentDecision } from '../src/skills/practice-trial-assessment-storage';
import { explainSkillEligibility } from '../src/skills/eligibility';
let issued: Awaited<ReturnType<typeof recordAssessment>>;
const readOwn = (
  a = subject,
  body: unknown = { version: 'v1', taxonomyId: catalogId, skillId: 'frontend' },
  canRead = () => true,
) => runCommandTransaction(db, (tx) => readOwnSkillAssessment(tx, a, body, canRead));
const decide = (
  action = 'REQUIRE_REASSESSMENT',
  wrap: (tx: CommandReceiptTransaction) => CommandReceiptTransaction = (tx) => tx,
) =>
  runCommandTransaction(db, (tx) =>
    recordPracticeAssessmentDecision(
      wrap(tx),
      {
        actor: evaluator,
        input: {
          version: 'v1',
          assignmentId: assessmentAssignmentId,
          submissionId,
          expectedAssessmentReference: issued.view.assessment!.reference,
          expectedReviewReference: issued.view.review.reference,
          expectedOwnershipReference: confirmedOwnershipReference,
          expectedPolicyReference: { recordId: assessmentPolicyId, revision: 1 },
          action,
          reasonCategory:
            action === 'REVOKE' ? 'FRAUDULENT_ASSESSMENT_EVIDENCE' : 'CAPABILITY_RECHECK',
          reason: 'Synthetic manual case.',
          findings: [
            {
              kind: action === 'REVOKE' ? 'ASSESSMENT_EVIDENCE' : 'CAPABILITY_EVIDENCE',
              detail: 'Synthetic original case finding.',
            },
          ],
          dueAt: action === 'REVOKE' ? null : new Date(Date.now() + 3600000).toISOString(),
        },
        idempotencyKey: randomUUID(),
        requestId: 'synthetic-own-state',
      },
      {
        allowNewWrites: true,
        canRead: () => true,
        canUsePolicy: () => true,
        canDecide: () => true,
      },
    ),
  );
integration('T013D7 actual owned current assessment summary', () => {
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

  it('observes only actual own current verification and feeds current facts into existing eligibility predicates', async () => {
    const r = await readOwn();
    expect(r.view).toMatchObject({
      skillId: 'frontend',
      effectiveStatus: 'VERIFIED',
      assessedRank: 'A',
      reasonCategory: null,
    });
    expect(r.evidence?.kind).toBe('ASSESSMENT');
    expect(r.evidence?.assessmentReference).toEqual(issued.view.assessment!.reference);
    expect(r.participant.id).toBe(participantId);
    const result = explainSkillEligibility(
      {
        version: 'v1',
        now: r.observedAt,
        taxonomy: r.taxonomy,
        participants: [
          {
            participant: r.participant,
            evidence: {
              status: 'AT_OBSERVATION',
              observedAt: r.observedAt,
              skills: r.evidence ? [r.evidence] : [],
            },
          },
        ],
      },
      {
        version: 'v1',
        coverage: 'ONE_MEMBER',
        requirement: {
          kind: 'SKILL',
          skillId: 'frontend',
          minimumRank: 'B',
          verificationRequired: true,
          assessmentPolicyVersion: issued.view.assessment!.assessmentPolicyVersion,
        },
      },
    );
    expect(result.status).toBe('MET');
    expect(result.isAuthorizationToken).toBe(false);
    expect(JSON.stringify(r.view)).not.toContain(assessmentInput().reason);
    expect(JSON.stringify(r.view)).not.toContain(input().answer);
    expect(await db.outboxEvent.count()).toBe(0);
  });
  it.each(['REQUIRE_REASSESSMENT', 'REVOKE'])(
    'reads current %s rather than the old VERIFIED snapshot',
    async (action) => {
      await decide(action);
      const r = await readOwn();
      expect(r.view.effectiveStatus).toBe(
        action === 'REVOKE' ? 'REVOKED' : 'REASSESSMENT_REQUIRED',
      );
      expect(r.evidence?.state).toBe(r.view.effectiveStatus);
      expect(r.evidence?.assessmentReference.revision).toBe(2);
      expect((await readAssessment())!.assessment!.state).toBe('VERIFIED');
    },
  );
  it('returns no assessment for another actual own participant instead of exposing someone else rank', async () => {
    const other = await actor();
    const r = await readOwn(other);
    expect(r.view.effectiveStatus).toBe('NO_ASSESSMENT');
    expect(r.view.assessedRank).toBeNull();
    expect(r.evidence).toBeNull();
    expect(r.participant.id).not.toBe(participantId);
  });
  it.each([
    { participantId: 'foreign' },
    { assessmentReference: { recordId: 'old', revision: 1 } },
    { skillId: '<script>' },
    { taxonomyId: ' bad ' },
  ])('rejects caller identity/source selectors %j', async (patch) => {
    await expect(
      readOwn(subject, { version: 'v1', taxonomyId: catalogId, skillId: 'frontend', ...patch }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it('denies current own read scope and revoked/wrong-owner session before fields', async () => {
    await expect(readOwn(subject, undefined, () => false)).rejects.toMatchObject({
      code: 'RESOURCE_UNAVAILABLE',
    });
    await expect(readOwn({ ...subject, sessionHash: evaluator.sessionHash })).rejects.toMatchObject(
      { code: 'AUTHENTICATION_REQUIRED' },
    );
    await db.session.deleteMany({ where: { tokenHash: subject.sessionHash } });
    await expect(readOwn()).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
  });
  it('does not turn a real self-reported A/S claim into an actual assessment', async () => {
    const other = await actor();
    await runCommandTransaction(db, (tx) =>
      saveSkillClaim(
        tx,
        {
          actor: other,
          input: {
            taxonomyId: catalogId,
            expectedTaxonomyRevision: 1,
            expectedClaimRevision: 0,
            skillId: 'frontend',
            claimedLevel: 'A / S expert — self-reported only',
            supportingReferences: [],
          },
          idempotencyKey: randomUUID(),
          requestId: 'synthetic-unverified-claim',
        },
        { allowNewWrites: true },
      ),
    );
    const r = await readOwn(other);
    expect(r.view.effectiveStatus).toBe('NO_ASSESSMENT');
    expect(r.evidence).toBeNull();
  });
  it('uses the actual database reassessment deadline without rewriting the committed VERIFIED history', async () => {
    const due = new Date(Date.now() + 1500).toISOString();
    await recordAssessment({
      ...assessmentInput(),
      expectedReviewReference: issued.view.review.reference,
      expectedAssessmentReference: issued.view.assessment!.reference,
      reassessmentAt: due,
    });
    expect((await readOwn()).view.effectiveStatus).toBe('VERIFIED');
    await new Promise((r) => setTimeout(r, 1800));
    const r = await readOwn();
    expect(r.view.recordedState).toBe('VERIFIED');
    expect(r.view.effectiveStatus).toBe('REASSESSMENT_REQUIRED');
    expect(r.view.reasonCategory).toBeNull();
    expect(r.evidence?.state).toBe('VERIFIED');
    expect(r.evidence?.reassessmentAt).toBe(due);
    const explained = explainSkillEligibility(
      {
        version: 'v1',
        now: r.observedAt,
        taxonomy: r.taxonomy,
        participants: [
          {
            participant: r.participant,
            evidence: {
              status: 'AT_OBSERVATION',
              observedAt: r.observedAt,
              skills: r.evidence ? [r.evidence] : [],
            },
          },
        ],
      },
      {
        version: 'v1',
        coverage: 'ONE_MEMBER',
        requirement: {
          kind: 'SKILL',
          skillId: 'frontend',
          minimumRank: 'B',
          verificationRequired: true,
          assessmentPolicyVersion: issued.view.assessment!.assessmentPolicyVersion,
        },
      },
    );
    expect(explained.status).toBe('UNMET');
  }, 10000);
  it('retains documented assessment after policy withdrawal rather than silently revoking it', async () => {
    await publishPolicy({
      ...policyInput(),
      policyId: assessmentPolicyId,
      purpose: 'ASSESSMENT_REVIEW',
      expectedRevision: 1,
      state: 'WITHDRAWN',
    });
    expect((await readOwn()).view.effectiveStatus).toBe('VERIFIED');
  });
  it('rejects a different real catalog namespace even when it reuses the skill ID/domain', async () => {
    await runCommandTransaction(db, (tx) =>
      publishSkillTaxonomy(
        tx,
        {
          actor: publisher,
          input: { taxonomyId: 'another-catalog', expectedRevision: 0, skills },
          idempotencyKey: randomUUID(),
          requestId: 'synthetic-another-catalog',
        },
        { allowNewWrites: true, canPublish: () => true },
      ),
    );
    await expect(
      readOwn(subject, { version: 'v1', taxonomyId: 'another-catalog', skillId: 'frontend' }),
    ).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
  });
  it('requires an actual canonical human and unrestricted account before assessment metadata', async () => {
    const unmapped = await actor(false, false);
    await expect(readOwn(unmapped)).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
    await db.user.update({ where: { id: subject.accountId }, data: { suspended: true } });
    await expect(readOwn()).rejects.toMatchObject({ code: 'ACCOUNT_RESTRICTED' });
    expect(
      (
        await db.$queryRawUnsafe<{ revision: number }[]>('SELECT "revision" FROM "SkillAssessment"')
      )[0].revision,
    ).toBe(1);
  });
  it('audits before bounded assessment fields, never selects private answers/case notes, and returns no fields after final scope loss', async () => {
    let audited = false,
      selected = false,
      enabled = true;
    const pending = runCommandTransaction(db, (tx) =>
      readOwnSkillAssessment(
        {
          ...tx,
          async query<Row>(sql: string, b: readonly (string | null)[]) {
            if (sql.startsWith('SELECT')) {
              expect(sql).not.toMatch(
                /\."(?:answer|explanation|reason|findings|confidenceStatement)"/,
              );
              if (sql.includes('v."assessedRank"')) {
                expect(audited).toBe(true);
                selected = true;
              }
            }
            const rows = await tx.query<Row>(sql, b);
            if (
              sql.includes('INSERT INTO "AuditEvent"') &&
              b[3] === 'skill.own_assessment_access_authorized.v1'
            )
              audited = true;
            if (selected) enabled = false;
            return rows;
          },
        },
        subject,
        { version: 'v1', taxonomyId: catalogId, skillId: 'frontend' },
        () => enabled,
      ),
    );
    await expect(pending).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
    expect(audited && selected).toBe(true);
  });
  it('sanitizes a throwing scoped read policy before selecting fields', async () => {
    const failure = readOwn(subject, undefined, () => {
      throw Error('private-own-policy-marker');
    });
    await expect(failure).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await expect(failure).rejects.not.toThrow('private-own-policy-marker');
  });
  it('rechecks actual own session expiry after a real rank-lock wait before source fields', async () => {
    await db.session.updateMany({
      where: { tokenHash: subject.sessionHash },
      data: { expiresAt: new Date(Date.now() + 1800) },
    });
    let release!: () => void, ready!: () => void, pidReady!: (pid: number) => void;
    const hold = new Promise<void>((r) => (release = r)),
      locked = new Promise<void>((r) => (ready = r)),
      pidAvailable = new Promise<number>((r) => (pidReady = r));
    const blocker = runCommandTransaction(db, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,12022))::text', [
        participantId + ':frontend',
      ]);
      ready();
      await hold;
    });
    await locked;
    let selected = false;
    const reading = runCommandTransaction(db, async (tx) => {
      const [r] = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid', []);
      pidReady(r.pid);
      return readOwnSkillAssessment(
        {
          ...tx,
          async query<Row>(sql: string, b: readonly (string | null)[]) {
            if (sql.includes('v."assessedRank"')) selected = true;
            return tx.query<Row>(sql, b);
          },
        },
        subject,
        { version: 'v1', taxonomyId: catalogId, skillId: 'frontend' },
        () => true,
      );
    }).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    );
    try {
      const pid = await pidAvailable;
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        const [r] = await db.$queryRawUnsafe<{ waiting: boolean }[]>(
          "SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",
          pid,
        );
        if (r?.waiting) {
          waiting = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(waiting).toBe(true);
      await new Promise((r) => setTimeout(r, 1900));
    } finally {
      release();
      await blocker;
    }
    expect(await reading).toMatchObject({
      value: null,
      error: { code: 'AUTHENTICATION_REQUIRED' },
    });
    expect(selected).toBe(false);
  }, 10000);
  it('loads the newly committed state after an actual concurrent decision holds the rank mutex', async () => {
    let resume!: () => void, locked!: () => void;
    const hold = new Promise<void>((r) => (resume = r)),
      ready = new Promise<void>((r) => (locked = r));
    let paused = false;
    const writing = decide('REVOKE', (tx) => ({
      ...tx,
      async query<Row>(sql: string, b: readonly (string | null)[]) {
        const rows = await tx.query<Row>(sql, b);
        if (sql.includes('12022') && !paused) {
          paused = true;
          locked();
          await hold;
        }
        return rows;
      },
    }));
    await ready;
    let pidReady!: (pid: number) => void;
    const pidAvailable = new Promise<number>((r) => (pidReady = r));
    const reading = runCommandTransaction(db, async (tx) => {
      const [r] = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid', []);
      pidReady(r.pid);
      return readOwnSkillAssessment(
        tx,
        subject,
        { version: 'v1', taxonomyId: catalogId, skillId: 'frontend' },
        () => true,
      );
    });
    try {
      const pid = await pidAvailable;
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        const [r] = await db.$queryRawUnsafe<{ waiting: boolean }[]>(
          "SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",
          pid,
        );
        if (r?.waiting) {
          waiting = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(waiting).toBe(true);
    } finally {
      resume();
      await writing;
    }
    const r = await reading;
    expect(r.view.effectiveStatus).toBe('REVOKED');
    expect(r.view.assessmentReference?.revision).toBe(2);
  }, 10000);
});
