import { readPracticeTrialForReview } from '../src/skills/practice-review-read-storage';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/lib/db';
import { hash } from '../src/lib/auth-primitives';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { executeIdempotentCommand } from '../src/command-receipts';
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
  observeApprovedPracticeReviewPolicy,
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
  PracticeTrialOwnershipRecordSchema,
  PracticeTrialOwnershipViewSchema,
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
const readOwnership = (
  revision: number | undefined = undefined,
  a = evaluator,
  id = assignmentId,
  purpose = 'OWNERSHIP_REVIEW',
  canRead = ownershipOptions.canRead,
) =>
  runCommandTransaction(db, (tx) =>
    readPracticeTrialOwnership(
      tx,
      a,
      { version: 'v1', assignmentId: id, submissionId, purpose, revision },
      canRead,
    ),
  );
integration('T013D4 actual immutable trial ownership findings', () => {
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
  });
  afterAll(() => db.$disconnect());
  it('commits actual attributed canonical finding with private access provenance and no rank/grant/money or original declaration mutation', async () => {
    const r = await recordOwnership();
    expect(r.status).toBe('EXECUTED');
    expect(r.view.record).toMatchObject({
      reference: { recordId: submissionId, revision: 1 },
      submissionReference: { recordId: submissionId, revision: 1 },
      definitionReference: { recordId: trialId, revision: 1 },
      rubricReference: { recordId: 'synthetic-submission-rubric', revision: 1 },
      policyReference: { recordId: policyId, revision: 1 },
      assignmentId,
      evaluatorAccountId: evaluator.accountId,
      decision: 'CONFIRM',
      ownership: 'CONFIRMED',
      persisted: true,
      verifiesSkill: false,
      isAuthorizationToken: false,
      createsPermissionGrant: false,
      consumesCapacity: false,
      createsFinancialObligation: false,
    });
    expect(r.view.isCurrent).toBe(true);
    expect(r.view.record.caseAccessId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.view.record.policyAccessId).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      (
        await runCommandTransaction(db, (tx) =>
          readPracticeTrialSubmission(tx, subject, submissionId),
        )
      )?.ownership,
    ).toBe('UNCONFIRMED');
    expect(await db.outboxEvent.count()).toBe(0);
  });
  it('has no current finding before a decision rather than confirming a claimant declaration', async () => {
    expect(await readOwnership()).toBeNull();
  });
  it('appends correction preserving original private history and explicit current pointer', async () => {
    const first = await recordOwnership();
    const second = await recordOwnership({
      ...ownershipInput(),
      expectedOwnershipReference: first.view.record.reference,
      decision: 'DISPUTE',
      reason: 'Synthetic correction requests evidence; no fraud conviction.',
    });
    expect(second.view.record).toMatchObject({
      reference: { recordId: submissionId, revision: 2 },
      ownership: 'DISPUTED',
    });
    expect((await readOwnership(1))?.isCurrent).toBe(false);
    expect((await readOwnership())?.record).toEqual(second.view.record);
  });
  it('records more evidence as UNCONFIRMED without automatic rank or culpability', async () => {
    expect(
      (await recordOwnership({ ...ownershipInput(), decision: 'MORE_EVIDENCE' })).view.record
        .ownership,
    ).toBe('UNCONFIRMED');
  });
  it('replays original unknown-success result after correction/writeoff/policywithdrawal under current read permission', async () => {
    const key = randomUUID(),
      body = ownershipInput(),
      first = await recordOwnership(body, evaluator, ownershipOptions, key);
    await recordOwnership({
      ...body,
      expectedOwnershipReference: first.view.record.reference,
      decision: 'MORE_EVIDENCE',
    });
    await publishPolicy({ ...policyInput(), expectedRevision: 1, state: 'WITHDRAWN' });
    const replay = await recordOwnership(
      body,
      evaluator,
      {
        ...ownershipOptions,
        allowNewWrites: false,
        canUsePolicy: () => false,
        canReview: () => false,
      },
      key,
    );
    expect(replay.status).toBe('REPLAYED');
    expect(replay.view.record).toEqual(first.view.record);
    expect(replay.view.isCurrent).toBe(false);
    expect(replay.view.accessId).not.toBe(first.view.accessId);
  });
  it('rejects changed body on the same idempotency key', async () => {
    const key = randomUUID();
    await recordOwnership(ownershipInput(), evaluator, ownershipOptions, key);
    await expect(
      recordOwnership({ ...ownershipInput(), reason: 'Changed' }, evaluator, ownershipOptions, key),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });
  it('requires exact CAS and serializes two competing independent decisions', async () => {
    const r = await Promise.allSettled([
      recordOwnership(),
      recordOwnership({ ...ownershipInput(), decision: 'MORE_EVIDENCE' }),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(r.filter((x) => x.status === 'rejected')).toHaveLength(1);
    expect(r.find((x) => x.status === 'rejected')).toMatchObject({
      reason: { code: 'REVISION_CHANGED' },
    });
  });
  it.each([
    'expectedSubmissionReference',
    'expectedDefinitionReference',
    'expectedRubricReference',
    'expectedPolicyReference',
  ])('denies changed original or current %s', async (field) => {
    await expect(
      recordOwnership({ ...ownershipInput(), [field]: { recordId: 'foreign', revision: 1 } }),
    ).rejects.toMatchObject({ code: 'REVISION_CHANGED' });
  });
  it('requires actual current policy, rejects withdrawn and stale approved history', async () => {
    await publishPolicy({ ...policyInput(), expectedRevision: 1, state: 'WITHDRAWN' });
    await expect(
      recordOwnership({
        ...ownershipInput(),
        expectedPolicyReference: { recordId: policyId, revision: 2 },
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
    await expect(recordOwnership()).rejects.toMatchObject({ code: 'REVISION_CHANGED' });
  });
  it('denies writeoff without leaving a business outcome or command receipt', async () => {
    await expect(
      recordOwnership(ownershipInput(), evaluator, { ...ownershipOptions, allowNewWrites: false }),
    ).rejects.toMatchObject({ code: 'WRITES_DISABLED' });
    expect(
      await db.commandReceipt.count({ where: { commandKind: 'RecordPracticeTrialOwnership' } }),
    ).toBe(0);
  });
  it.each(['canRead', 'canUsePolicy', 'canReview'])(
    'fails closed when current %s denies',
    async (field) => {
      await expect(
        recordOwnership(ownershipInput(), evaluator, { ...ownershipOptions, [field]: () => false }),
      ).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
    },
  );
  it('requires exact assigned evaluator rather than admin role or claimant', async () => {
    await expect(recordOwnership(ownershipInput(), publisher)).rejects.toMatchObject({
      code: 'RESOURCE_UNAVAILABLE',
    });
    await expect(recordOwnership(ownershipInput(), subject)).rejects.toMatchObject({
      code: 'RESOURCE_UNAVAILABLE',
    });
  });
  it('denies lost own session and suspended current evaluator', async () => {
    await db.session.deleteMany({ where: { userId: evaluator.accountId } });
    await expect(recordOwnership()).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
  });
  it('denies assignment revocation for new writes/history/replay', async () => {
    const key = randomUUID();
    await recordOwnership(ownershipInput(), evaluator, ownershipOptions, key);
    await revoke(assignmentId);
    expect(await readOwnership()).toBeNull();
    await expect(
      recordOwnership(ownershipInput(), evaluator, ownershipOptions, key),
    ).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
  });
  it('denies expired or wrong-purpose assignment', async () => {
    const a = await issue({ ...grantInput(), purpose: 'ASSESSMENT_REVIEW' });
    await expect(
      recordOwnership({ ...ownershipInput(), assignmentId: a.assignment.id }),
    ).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
  });
  it('only exposes historical reason under actual current exact case assignment; assessment reviewers may inspect ownership without gaining ownership write authority', async () => {
    const r = await recordOwnership();
    expect(await readOwnership(undefined, publisher)).toBeNull();
    expect(await readOwnership(undefined, evaluator, assignmentId, 'ASSESSMENT_REVIEW')).toBeNull();
    const a = await issue({ ...grantInput(), purpose: 'ASSESSMENT_REVIEW' });
    expect(
      (await readOwnership(undefined, evaluator, a.assignment.id, 'ASSESSMENT_REVIEW'))?.record,
    ).toEqual(r.view.record);
  });
  it.each(['', 'x'.repeat(2001), '😀'.repeat(1001), 'x\u0000', 'x\ud800'])(
    'rejects malformed or over-UTF16 private reason before queries',
    async (reason) => {
      await expect(recordOwnership({ ...ownershipInput(), reason })).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    },
  );
  it('preserves literal SQL/HTML shaped reviewer observations without executing them', async () => {
    const reason = '<script>literal</script>\'; DROP TABLE "User";--';
    expect((await recordOwnership({ ...ownershipInput(), reason })).view.record.reason).toBe(
      reason,
    );
    expect(await db.user.count()).toBe(3);
  });
  it('audits private ownership history before reason/observations and fails closed without leaking driver text', async () => {
    await recordOwnership();
    let observed = false;
    const read = (failAudit: boolean) =>
      runCommandTransaction(db, (tx) =>
        readPracticeTrialOwnership(
          {
            ...tx,
            async query<Row>(sql: string, bindings: readonly (string | null)[]) {
              if (failAudit && sql.includes('INSERT INTO "AuditEvent"'))
                throw new Error('private-ownership-audit-marker');
              if (sql.includes('v."reason",v."observations"')) {
                const rows = await tx.query<{ n: number }>(
                  'SELECT count(*)::int n FROM "AuditEvent" WHERE "eventType"=$1',
                  ['skill.practice_trial_ownership_access_authorized.v1'],
                );
                expect(rows[0].n).toBeGreaterThanOrEqual(2);
                observed = true;
              }
              return tx.query<Row>(sql, bindings);
            },
          },
          evaluator,
          { version: 'v1', assignmentId, submissionId, purpose: 'OWNERSHIP_REVIEW' },
          () => true,
        ),
      );
    expect((await read(false))?.private).toBe(true);
    expect(observed).toBe(true);
    observed = false;
    const failure = read(true);
    await expect(failure).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await expect(failure).rejects.not.toThrow('private-ownership-audit-marker');
    expect(observed).toBe(false);
  });
  it('drops private history if scoped access changes during private selection', async () => {
    await recordOwnership();
    let enabled = true;
    const r = await runCommandTransaction(db, (tx) =>
      readPracticeTrialOwnership(
        {
          ...tx,
          async query<Row>(sql: string, bindings: readonly (string | null)[]) {
            const rows = await tx.query<Row>(sql, bindings);
            if (sql.includes('v."reason",v."observations"')) enabled = false;
            return rows;
          },
        },
        evaluator,
        { version: 'v1', assignmentId, submissionId, purpose: 'OWNERSHIP_REVIEW' },
        () => enabled,
      ),
    );
    expect(r).toBeNull();
  });
  it('keeps private ownership audit identifier-only without outbox or original submission bytes', async () => {
    const r = await recordOwnership();
    await readOwnership();
    const events = await db.$queryRawUnsafe<{ payload: unknown }[]>(
      'SELECT "payload" FROM "AuditEvent" WHERE "eventType" LIKE $1',
      'skill.practice_trial_ownership_%',
    );
    expect(events.length).toBe(3);
    for (const e of events)
      expect(e.payload).toEqual({ practiceTrialOwnershipVersionId: r.view.record.id });
    expect(await db.outboxEvent.count()).toBe(0);
  });
  it('passes actual current case and canonical policy scope to the decision policy before committing', async () => {
    let checks = 0;
    await recordOwnership(ownershipInput(), evaluator, {
      ...ownershipOptions,
      canReview: (scope) => {
        expect(scope).toMatchObject({
          actorAccountId: evaluator.accountId,
          assignmentId,
          submissionReference: { recordId: submissionId, revision: 1 },
          participantId,
          definitionReference: { recordId: trialId, revision: 1 },
          rubricReference: { recordId: 'synthetic-submission-rubric', revision: 1 },
          skillId: 'frontend',
          skillDomain: 'web',
          currentOwnershipReference: null,
          decision: 'CONFIRM',
        });
        expect(scope.policyVersionId).toMatch(/^[0-9a-f-]{36}$/);
        checks++;
        return true;
      },
    });
    expect(checks).toBeGreaterThanOrEqual(2);
  });
  it('sanitizes thrown decision policy and rolls back attempted private access with business outcome', async () => {
    const failure = recordOwnership(ownershipInput(), evaluator, {
      ...ownershipOptions,
      canReview: () => {
        throw new Error('private-decision-policy-marker');
      },
    });
    await expect(failure).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await expect(failure).rejects.not.toThrow('private-decision-policy-marker');
    expect(await readOwnership()).toBeNull();
  });
  type RawPatch = {
    reason?: string;
    observations?: unknown;
    revision?: number;
    assignmentId?: string;
    definitionId?: string;
    policyId?: string;
    evaluatorId?: string;
    decision?: string;
    reviewedAt?: string;
    kind?: string;
    wrongActor?: boolean;
    noAudit?: boolean;
    outbox?: boolean;
    wrongPayload?: boolean;
    wrongResult?: boolean;
    noPointer?: boolean;
    wrongCaseReceipt?: boolean;
    wrongPolicyReceipt?: boolean;
  };
  async function rawFinding(patch: RawPatch = {}) {
    let saved = '';
    await runCommandTransaction(db, (tx) =>
      executeIdempotentCommand(
        tx,
        {
          actorId: patch.wrongActor ? publisher.accountId : evaluator.accountId,
          commandKind: patch.kind ?? 'RecordPracticeTrialOwnership',
          idempotencyKey: randomUUID(),
          requestId: 'synthetic-raw-ownership',
          request: { synthetic: true },
        },
        async ({ receiptId }) => {
          const evidence = await readPracticeTrialForReview(
            tx,
            evaluator,
            { version: 'v1', assignmentId, submissionId, purpose: 'OWNERSHIP_REVIEW' },
            () => true,
          );
          expect(evidence).not.toBeNull();
          const approved = await observeApprovedPracticeReviewPolicy(
            tx,
            evaluator,
            { version: 'v1', assignmentId, submissionId, purpose: 'OWNERSHIP_REVIEW' },
            () => true,
          );
          expect(approved).not.toBeNull();
          const [d] = await tx.query<{ id: string }>(
            'SELECT "id"::text FROM "PracticeTrialVersion" WHERE "trialId"=$1 AND "revision"=1',
            [trialId],
          );
          const [c] = await tx.query<{ id: string }>(
            'SELECT "id"::text FROM "CommandReceipt" WHERE "actorId"=$1 AND "commandKind"=$2 AND "requestId"=$3',
            [evaluator.accountId, 'ReadPracticeTrialForReview', evidence!.accessId],
          );
          const [p] = await tx.query<{ id: string }>(
            'SELECT "id"::text FROM "CommandReceipt" WHERE "actorId"=$1 AND "commandKind"=$2 AND "requestId"=$3',
            [evaluator.accountId, 'ReadApprovedPracticeReviewPolicy', approved!.accessId],
          );
          const rev = patch.revision ?? 1;
          const [v] = await tx.query<{ id: string }>(
            `INSERT INTO "PracticeTrialOwnershipVersion"("submissionId","revision","assignmentId","definitionVersionId","policyVersionId","evaluatorAccountId","decision","reason","observations","caseAccessReceiptId","policyAccessReceiptId","reviewedAt","receiptId","requestId") VALUES($1::uuid,$2::int,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,$9::jsonb,$10::uuid,$11::uuid,COALESCE($12::timestamptz,date_trunc('milliseconds',clock_timestamp())),$13::uuid,$14) RETURNING "id"::text`,
            [
              submissionId,
              String(rev),
              patch.assignmentId ?? assignmentId,
              patch.definitionId ?? d.id,
              patch.policyId ?? approved!.policy.id,
              patch.evaluatorId ?? evaluator.accountId,
              patch.decision ?? 'CONFIRM',
              patch.reason ?? 'Synthetic raw finding.',
              JSON.stringify(patch.observations ?? ownershipInput().observations),
              patch.wrongCaseReceipt ? p.id : c.id,
              patch.wrongPolicyReceipt ? c.id : p.id,
              patch.reviewedAt ?? null,
              receiptId,
              'synthetic-raw-ownership',
            ],
          );
          saved = v.id;
          if (!patch.noPointer)
            await tx.query(
              'INSERT INTO "PracticeTrialOwnership"("submissionId","revision","currentVersionId") VALUES($1::uuid,$2::int,$3::uuid)',
              [submissionId, String(rev), v.id],
            );
          return {
            resultRef: patch.wrongResult ? randomUUID() : v.id,
            events: patch.noAudit
              ? [
                  {
                    type: 'synthetic.noop.v1',
                    aggregateId: submissionId,
                    aggregateVersion: rev,
                    payload: {},
                    publish: false,
                  },
                ]
              : [
                  {
                    type: 'skill.practice_trial_ownership_recorded.v1',
                    aggregateId: submissionId,
                    aggregateVersion: rev,
                    payload: {
                      practiceTrialOwnershipVersionId: patch.wrongPayload ? randomUUID() : v.id,
                    },
                    publish: patch.outbox ?? false,
                  },
                ],
          };
        },
      ),
    );
    return saved;
  }
  it('raw SQL valid control commits only actual current case/policy with private access and finalized receipt/audit', async () => {
    const id = await rawFinding();
    expect((await readOwnership())?.record.id).toBe(id);
  });
  it.each([
    { reason: ' ' },
    { reason: ' untrimmed ' },
    { reason: '😀'.repeat(1001) },
    { observations: [] },
    { observations: [{ kind: 'OTHER', detail: ' x ' }] },
    { observations: [{ kind: 'OTHER', detail: 'x', extra: 'y' }] },
    { revision: 0 },
    { revision: 2 },
    { decision: 'AUTO_CONFIRMED' },
    { assignmentId: '00000000-0000-4000-8000-000000000000' },
    { definitionId: '00000000-0000-4000-8000-000000000000' },
    { policyId: '00000000-0000-4000-8000-000000000000' },
    { evaluatorId: 'foreign' },
    { reviewedAt: '2000-01-01T00:00:00Z' },
    { reviewedAt: '2100-01-01T00:00:00Z' },
    { kind: 'WrongKind' },
    { wrongActor: true },
    { noAudit: true },
    { outbox: true },
    { wrongPayload: true },
    { wrongResult: true },
    { noPointer: true },
    { wrongCaseReceipt: true },
    { wrongPolicyReceipt: true },
  ])('raw SQL rejects invalid finding/provenance/clock/private finalization %s', async (patch) => {
    await expect(rawFinding(patch)).rejects.toBeDefined();
    expect(
      await db.$queryRawUnsafe('SELECT count(*)::int n FROM "PracticeTrialOwnershipVersion"'),
    ).toEqual([{ n: 0 }]);
  });
  it.each([
    `UPDATE "PracticeTrialOwnershipVersion" SET "reason"='rewritten' WHERE "id"=$1::uuid`,
    'UPDATE "PracticeTrialOwnershipVersion" SET "id"="id" WHERE "id"=$1::uuid',
    'DELETE FROM "PracticeTrialOwnershipVersion" WHERE "id"=$1::uuid',
  ])('preserves immutable ownership history under SQL %s', async (sql) => {
    const r = await recordOwnership();
    await expect(db.$executeRawUnsafe(sql, r.view.record.id)).rejects.toBeDefined();
    expect((await readOwnership())?.record).toEqual(r.view.record);
  });
  it('rejects pointer deletion or rewind after a recorded correction', async () => {
    const first = await recordOwnership();
    await recordOwnership({
      ...ownershipInput(),
      expectedOwnershipReference: first.view.record.reference,
      decision: 'MORE_EVIDENCE',
    });
    await expect(
      db.$executeRawUnsafe(
        'DELETE FROM "PracticeTrialOwnership" WHERE "submissionId"=$1::uuid',
        submissionId,
      ),
    ).rejects.toBeDefined();
    await expect(
      db.$executeRawUnsafe(
        'UPDATE "PracticeTrialOwnership" SET "revision"=1,"currentVersionId"=$2::uuid WHERE "submissionId"=$1::uuid',
        submissionId,
        first.view.record.id,
      ),
    ).rejects.toBeDefined();
    expect((await readOwnership())?.record.reference.revision).toBe(2);
  });
  it.each([null, 1, {}, []])('raw SQL rejects non-enum observation kind %s', async (kind) => {
    await expect(
      rawFinding({ observations: [{ kind, detail: 'Synthetic observation.' }] }),
    ).rejects.toBeDefined();
  });
  it('serializes competing distinct actual evaluators without duplicate current ownership or overwriting a winning finding', async () => {
    const other = await actor(false, false);
    const appointed = await issue(
      { ...grantInput(), evaluatorAccountId: other.accountId },
      publisher,
      { allowNewWrites: true, canManage: () => true },
    );
    const r = await Promise.allSettled([
      recordOwnership(),
      recordOwnership(
        { ...ownershipInput(), assignmentId: appointed.assignment.id, decision: 'MORE_EVIDENCE' },
        other,
      ),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(r.filter((x) => x.status === 'rejected')).toHaveLength(1);
    expect(r.find((x) => x.status === 'rejected')).toMatchObject({
      reason: { code: 'REVISION_CHANGED' },
    });
    expect((await readOwnership())?.record.reference.revision).toBe(1);
  });
  it('rechecks actual assignment after ownership-lock wait before decision policy or finding insertion', async () => {
    assignmentId = (
      await issue({ ...grantInput(), expiresAt: new Date(Date.now() + 2500).toISOString() })
    ).assignment.id;
    let release!: () => void, locked!: () => void, pidReady!: (id: number) => void;
    const hold = new Promise<void>((r) => (release = r)),
      ready = new Promise<void>((r) => (locked = r)),
      waitingPid = new Promise<number>((r) => (pidReady = r));
    const blocker = runCommandTransaction(db, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,12020))::text', [
        submissionId,
      ]);
      locked();
      await hold;
    });
    await ready;
    let decisionChecks = 0;
    const writing = runCommandTransaction(db, async (tx) => {
      const [r] = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid', []);
      pidReady(r.pid);
      return recordPracticeTrialOwnership(
        tx,
        {
          actor: evaluator,
          input: ownershipInput(),
          idempotencyKey: randomUUID(),
          requestId: 'synthetic-expiry-wait',
        },
        {
          ...ownershipOptions,
          canReview: () => {
            decisionChecks++;
            return true;
          },
        },
      );
    }).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    );
    try {
      const pid = await waitingPid;
      let waiting = false;
      for (let n = 0; n < 100; n++) {
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
      await new Promise((r) => setTimeout(r, 2600));
    } finally {
      release();
      await blocker;
    }
    expect(await writing).toMatchObject({ value: null, error: { code: 'RESOURCE_UNAVAILABLE' } });
    expect(decisionChecks).toBe(0);
    expect(
      await db.$queryRawUnsafe('SELECT count(*)::int n FROM "PracticeTrialOwnershipVersion"'),
    ).toEqual([{ n: 0 }]);
  });
  it.each(['deleted', 'expired', 'foreign', 'restricted'])(
    'denies current evaluator authority loss %s even for an original retry',
    async (change) => {
      const key = randomUUID();
      await recordOwnership(ownershipInput(), evaluator, ownershipOptions, key);
      if (change === 'deleted')
        await db.session.delete({ where: { tokenHash: evaluator.sessionHash } });
      if (change === 'expired')
        await db.session.update({
          where: { tokenHash: evaluator.sessionHash },
          data: { expiresAt: new Date(0) },
        });
      if (change === 'foreign')
        await db.session.update({
          where: { tokenHash: evaluator.sessionHash },
          data: { userId: publisher.accountId },
        });
      if (change === 'restricted')
        await db.user.update({ where: { id: evaluator.accountId }, data: { suspended: true } });
      await expect(
        recordOwnership(ownershipInput(), evaluator, ownershipOptions, key),
      ).rejects.toMatchObject({
        code: change === 'restricted' ? 'ACCOUNT_RESTRICTED' : 'AUTHENTICATION_REQUIRED',
      });
    },
  );
  it('rejects noncurrent policy UUID on raw insert despite a valid historical APPROVED version', async () => {
    const [old] = await db.$queryRawUnsafe<{ id: string }[]>(
      'SELECT "id"::text FROM "PracticeReviewPolicyVersion" WHERE "policyId"=$1 AND "revision"=1',
      policyId,
    );
    await publishPolicy({
      ...policyInput(),
      expectedRevision: 1,
      guidance: 'Synthetic updated current policy.',
    });
    await expect(rawFinding({ policyId: old.id })).rejects.toBeDefined();
  });
  it('does not let exposed record/view schemas turn historical input into a current authority token', async () => {
    const r = await recordOwnership();
    expect(
      PracticeTrialOwnershipRecordSchema.safeParse({ ...r.view.record, ownership: 'DISPUTED' })
        .success,
    ).toBe(false);
    expect(
      PracticeTrialOwnershipRecordSchema.safeParse({ ...r.view.record, verifiesSkill: true })
        .success,
    ).toBe(false);
    expect(
      PracticeTrialOwnershipRecordSchema.safeParse({
        ...r.view.record,
        submissionReference: { recordId: randomUUID(), revision: 1 },
      }).success,
    ).toBe(false);
    expect(
      PracticeTrialOwnershipViewSchema.safeParse({ ...r.view, isCurrent: false }).success,
    ).toBe(false);
    expect(
      PracticeTrialOwnershipViewSchema.safeParse({
        ...r.view,
        currentReference: { recordId: randomUUID(), revision: 1 },
      }).success,
    ).toBe(false);
  });
  it.each(['canReview', 'canUsePolicy'])(
    'rechecks current %s after private result selection before committing a new finding',
    async (check) => {
      let enabled = true;
      const failure = runCommandTransaction(db, (tx) =>
        recordPracticeTrialOwnership(
          {
            ...tx,
            async query<Row>(sql: string, bindings: readonly (string | null)[]) {
              const rows = await tx.query<Row>(sql, bindings);
              if (sql.includes('v."reason",v."observations"')) enabled = false;
              return rows;
            },
          },
          {
            actor: evaluator,
            input: ownershipInput(),
            idempotencyKey: randomUUID(),
            requestId: 'synthetic-final-authority',
          },
          { ...ownershipOptions, [check]: () => enabled },
        ),
      );
      await expect(failure).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
      expect(await readOwnership()).toBeNull();
    },
  );
  it.each(['canRead', 'canUsePolicy'])(
    'fences distinct current %s when it closes during the final grant query after policy authorization',
    async (check) => {
      let privateSelected = false,
        finalGuideRead = false,
        policyAuthorizedAfterGuide = false,
        enabled = true,
        triggered = false;
      const failure = runCommandTransaction(db, (tx) =>
        recordPracticeTrialOwnership(
          {
            ...tx,
            async query<Row>(sql: string, bindings: readonly (string | null)[]) {
              const rows = await tx.query<Row>(sql, bindings);
              if (sql.includes('v."reason",v."observations"')) privateSelected = true;
              if (privateSelected && sql.includes('SELECT "guidance"')) finalGuideRead = true;
              if (
                policyAuthorizedAfterGuide &&
                sql.includes('SELECT "expiresAt">clock_timestamp() AS valid')
              ) {
                enabled = false;
                triggered = true;
              }
              return rows;
            },
          },
          {
            actor: evaluator,
            input: ownershipInput(),
            idempotencyKey: randomUUID(),
            requestId: 'synthetic-last-grant-scope',
          },
          {
            ...ownershipOptions,
            canRead: () => (check === 'canRead' ? enabled : true),
            canUsePolicy: () => {
              if (finalGuideRead) policyAuthorizedAfterGuide = true;
              return check === 'canUsePolicy' ? enabled : true;
            },
          },
        ),
      );
      await expect(failure).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
      expect(triggered).toBe(true);
      expect(await readOwnership()).toBeNull();
    },
  );
});
