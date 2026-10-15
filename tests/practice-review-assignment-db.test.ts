import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/lib/db';
import { hash } from '../src/lib/auth-primitives';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { executeIdempotentCommand, type CommandReceiptTransaction } from '../src/command-receipts';
import { publishSkillTaxonomy, type SkillTaxonomyActor } from '../src/skills/taxonomy-storage';
import { publishPracticeTrialDefinition } from '../src/skills/practice-trial-storage';
import { startPracticeTrial } from '../src/skills/practice-trial-attempt-storage';
import { submitPracticeTrial } from '../src/skills/practice-trial-submission-storage';
import {
  issuePracticeReviewAssignment,
  revokePracticeReviewAssignment,
  lockPracticeReviewAssignment,
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
const use = (
  id: string,
  a = evaluator,
  sub = submissionId,
  purpose: 'OWNERSHIP_REVIEW' | 'ASSESSMENT_REVIEW' = 'OWNERSHIP_REVIEW',
  canUse: Parameters<typeof lockPracticeReviewAssignment>[3] = () => true,
) =>
  runCommandTransaction(db, (tx) =>
    lockPracticeReviewAssignment(tx, a, { assignmentId: id, submissionId: sub, purpose }, canUse),
  );
integration('T013D1 explicit scoped private review assignments', () => {
  beforeAll(() => assertTestDatabase());
  beforeEach(async () => {
    await truncateAll(db);
    publisher = await actor(true, false);
    subject = await actor();
    evaluator = await actor(false, false);
    await publishCatalog();
    await publish();
    const begun = await begin();
    startId = begun.start.id;
    participantId = begun.start.participantId;
    submissionId = (await submit()).submission.reference.recordId;
  });
  afterAll(() => db.$disconnect());
  it('authenticates before exposing missing issue/revoke target outcomes', async () => {
    const forged = { ...publisher, sessionHash: 'f'.repeat(64) };
    await expect(
      issue({ ...grantInput(), submissionId: randomUUID() }, forged),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
    await expect(revoke(randomUUID(), forged)).rejects.toMatchObject({
      code: 'AUTHENTICATION_REQUIRED',
    });
  });
  it('supplies requested and saved finite expiry to current scoped management and use policies', async () => {
    const body = grantInput();
    const scoped = {
      ...policy,
      canManage: (scope: Parameters<typeof policy.canManage>[0]) =>
        policy.canManage(scope) && Reflect.get(scope, 'expiresAt') === body.expiresAt,
    };
    const g = await issue(body, publisher, scoped);
    expect(
      await use(
        g.assignment.id,
        evaluator,
        submissionId,
        'OWNERSHIP_REVIEW',
        (scope) => Reflect.get(scope, 'expiresAt') === body.expiresAt,
      ),
    ).toEqual(g.assignment);
    await expect(
      issue({ ...body, expiresAt: '2030-01-01T00:00:00.000Z' }, publisher, scoped),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      revoke(g.assignment.id, publisher, {
        ...policy,
        canManage: (scope) => Reflect.get(scope, 'expiresAt') !== body.expiresAt,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('issues exact immutable scope and authorizes actual designated evaluator only', async () => {
    const saved = await issue();
    expect(saved.status).toBe('EXECUTED');
    expect(saved.assignment).toMatchObject({
      version: 'v1',
      state: 'ISSUED',
      submissionId,
      evaluatorAccountId: evaluator.accountId,
      purpose: 'OWNERSHIP_REVIEW',
      isAuthorizationToken: false,
    });
    expect(await use(saved.assignment.id)).toEqual(saved.assignment);
    expect(await use(saved.assignment.id, subject)).toBeNull();
    expect(await use(saved.assignment.id, publisher)).toBeNull();
    expect(await use(saved.assignment.id, evaluator, randomUUID())).toBeNull();
    expect(await use(saved.assignment.id, evaluator, submissionId, 'ASSESSMENT_REVIEW')).toBeNull();
    expect(await use(randomUUID())).toBeNull();
  });
  it('keeps original issue receipt after disabled writes, retirement, expiry and revocation without claiming current access', async () => {
    const body = grantInput(),
      key = randomUUID();
    const first = await issue(body, publisher, policy, key);
    await publish(1, 'RETIRED');
    await revoke(first.assignment.id);
    const replay = await issue(body, publisher, { ...policy, allowNewWrites: false }, key);
    expect(replay.status).toBe('REPLAYED');
    expect(replay.assignment).toEqual(first.assignment);
    expect(await use(first.assignment.id)).toBeNull();
    await expect(
      issue({ ...body, reason: 'Changed reason' }, publisher, policy, key),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });
  it('revokes immutably with original receipt and no automatic alternate-key duplicate', async () => {
    const g = await issue(),
      key = randomUUID();
    const first = await revoke(g.assignment.id, publisher, policy, key);
    expect(first.status).toBe('EXECUTED');
    expect(first.revocation.assignmentId).toBe(g.assignment.id);
    expect(await use(g.assignment.id)).toBeNull();
    expect(
      await revoke(g.assignment.id, publisher, { ...policy, allowNewWrites: false }, key),
    ).toEqual({ ...first, status: 'REPLAYED' });
    await expect(revoke(g.assignment.id)).rejects.toMatchObject({ code: 'ALREADY_REVOKED' });
  });
  it.each(['OWNERSHIP_REVIEW', 'ASSESSMENT_REVIEW'])(
    'accepts separately explicit %s purpose without confirming work',
    async (purpose) => {
      const g = await issue({ ...grantInput(), purpose });
      expect(
        await use(
          g.assignment.id,
          evaluator,
          submissionId,
          purpose as 'OWNERSHIP_REVIEW' | 'ASSESSMENT_REVIEW',
        ),
      ).toEqual(g.assignment);
      expect(await submit(subject, input(), randomUUID()).catch(() => null)).toBeNull();
    },
  );
  it('denies direct self review even when policy would grant', async () => {
    await expect(
      issue({ ...grantInput(), evaluatorAccountId: subject.accountId }, publisher, {
        ...policy,
        canManage: () => true,
      }),
    ).rejects.toMatchObject({ code: 'SELF_REVIEW_FORBIDDEN' });
  });
  it('does not let new writes proceed when default host configuration is off', async () => {
    await expect(
      issue(grantInput(), publisher, { ...policy, allowNewWrites: false }),
    ).rejects.toMatchObject({ code: 'WRITES_DISABLED' });
    const g = await issue();
    await expect(
      revoke(g.assignment.id, publisher, { ...policy, allowNewWrites: false }),
    ).rejects.toMatchObject({ code: 'WRITES_DISABLED' });
    expect(await use(g.assignment.id)).not.toBeNull();
  });
  it.each(['wallet', 'CREATOR', 'no-x', 'suspended', 'expired', 'deleted'])(
    'requires current actual X-admin management authority: %s',
    async (change) => {
      if (change === 'wallet')
        await db.session.update({
          where: { tokenHash: publisher.sessionHash },
          data: { via: 'wallet' },
        });
      if (change === 'CREATOR')
        await db.user.update({ where: { id: publisher.accountId }, data: { role: 'CREATOR' } });
      if (change === 'no-x')
        await db.user.update({ where: { id: publisher.accountId }, data: { xId: null } });
      if (change === 'suspended')
        await db.user.update({ where: { id: publisher.accountId }, data: { suspended: true } });
      if (change === 'expired')
        await db.session.update({
          where: { tokenHash: publisher.sessionHash },
          data: { expiresAt: new Date(0) },
        });
      if (change === 'deleted')
        await db.session.delete({ where: { tokenHash: publisher.sessionHash } });
      await expect(issue()).rejects.toMatchObject({
        code:
          change === 'suspended'
            ? 'ACCOUNT_RESTRICTED'
            : ['expired', 'deleted'].includes(change)
              ? 'AUTHENTICATION_REQUIRED'
              : 'FORBIDDEN',
      });
    },
  );
  it.each(['suspended', 'expired', 'deleted', 'foreign-session'])(
    'requires evaluator current identity at use: %s',
    async (change) => {
      const g = await issue();
      if (change === 'suspended')
        await db.user.update({ where: { id: evaluator.accountId }, data: { suspended: true } });
      if (change === 'expired')
        await db.session.update({
          where: { tokenHash: evaluator.sessionHash },
          data: { expiresAt: new Date(0) },
        });
      if (change === 'deleted')
        await db.session.delete({ where: { tokenHash: evaluator.sessionHash } });
      const a =
        change === 'foreign-session'
          ? { ...evaluator, sessionHash: subject.sessionHash }
          : evaluator;
      await expect(use(g.assignment.id, a)).rejects.toMatchObject({
        code: change === 'suspended' ? 'ACCOUNT_RESTRICTED' : 'AUTHENTICATION_REQUIRED',
      });
    },
  );
  it('requires existing unrestricted evaluator and actual submission at issue', async () => {
    await expect(issue({ ...grantInput(), submissionId: randomUUID() })).rejects.toMatchObject({
      code: 'RESOURCE_UNAVAILABLE',
    });
    await expect(
      issue({ ...grantInput(), evaluatorAccountId: 'missing-account' }),
    ).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
    await db.user.update({ where: { id: evaluator.accountId }, data: { suspended: true } });
    await expect(issue()).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
  });
  it.each([false, undefined, 'true'])(
    'requires exact true scoped host policy, got %s',
    async (value) => {
      await expect(
        issue(grantInput(), publisher, { ...policy, canManage: () => value as boolean }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const g = await issue();
      expect(
        await use(
          g.assignment.id,
          evaluator,
          submissionId,
          'OWNERSHIP_REVIEW',
          () => value as boolean,
        ),
      ).toBeNull();
      await expect(
        revoke(g.assignment.id, publisher, { ...policy, canManage: () => value as boolean }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    },
  );
  it('fails closed when scoped policy throws', async () => {
    const broken = () => {
      throw new Error('private-marker');
    };
    await expect(
      issue(grantInput(), publisher, { ...policy, canManage: broken }),
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    const g = await issue();
    await expect(
      use(g.assignment.id, evaluator, submissionId, 'OWNERSHIP_REVIEW', broken),
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });
  it('never grants an already expired scope and does not extend elapsed authority', async () => {
    await expect(
      issue({ ...grantInput(), expiresAt: new Date(0).toISOString() }),
    ).rejects.toMatchObject({ code: 'EXPIRY_INVALID' });
    const body = { ...grantInput(), expiresAt: new Date(Date.now() + 500).toISOString() },
      key = randomUUID();
    const g = await issue(body, publisher, policy, key);
    await new Promise((r) => setTimeout(r, 550));
    expect(await use(g.assignment.id)).toBeNull();
    expect(
      (await issue(body, publisher, { ...policy, allowNewWrites: false }, key)).assignment,
    ).toEqual(g.assignment);
  });
  it('keeps submission bodies out of receipts/audits/outbox and creates only actual scoped records', async () => {
    const g = await issue();
    await revoke(g.assignment.id);
    const rows = await db.$queryRawUnsafe<{ payload: unknown; eventType: string }[]>(
      `SELECT "payload","eventType" FROM "AuditEvent" WHERE "eventType" LIKE 'skill.practice_review_assignment_%' ORDER BY "eventType"`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(Object.keys(row.payload as object)).toHaveLength(1);
    const all = JSON.stringify(
      await db.$queryRawUnsafe('SELECT "resultRef" FROM "CommandReceipt"'),
    );
    expect(all).not.toContain(input().answer);
    expect(await db.outboxEvent.count()).toBe(0);
  });
  it.each([
    `UPDATE "PracticeTrialReviewAssignment" SET "reason"='rewritten' WHERE "id"=$1::uuid`,
    'DELETE FROM "PracticeTrialReviewAssignment" WHERE "id"=$1::uuid',
  ])('SQL preserves immutable issued history %s', async (sql) => {
    const g = await issue();
    await expect(db.$executeRawUnsafe(sql, g.assignment.id)).rejects.toBeDefined();
    expect(await use(g.assignment.id)).toEqual(g.assignment);
  });
  it.each([
    `UPDATE "PracticeTrialReviewRevocation" SET "reason"='rewritten' WHERE "id"=$1::uuid`,
    'DELETE FROM "PracticeTrialReviewRevocation" WHERE "id"=$1::uuid',
  ])('SQL preserves immutable revocation history %s', async (sql) => {
    const g = await issue(),
      r = await revoke(g.assignment.id);
    await expect(db.$executeRawUnsafe(sql, r.revocation.id)).rejects.toBeDefined();
    expect(await use(g.assignment.id)).toBeNull();
  });
  async function rawIssue(
    patch: {
      purpose?: string;
      expiresAt?: string;
      reason?: string;
      evaluator?: string;
      subject?: string;
      issuedAt?: string;
      kind?: string;
      noAudit?: boolean;
      publish?: boolean;
      wrongPayload?: boolean;
      wrongResult?: boolean;
      wrongActor?: boolean;
    } = {},
  ) {
    const id = randomUUID(),
      body = grantInput();
    return runCommandTransaction(db, (tx) =>
      executeIdempotentCommand(
        tx,
        {
          actorId: patch.wrongActor ? evaluator.accountId : publisher.accountId,
          commandKind: patch.kind ?? 'IssuePracticeReviewAssignment',
          idempotencyKey: randomUUID(),
          requestId: 'raw-review',
          request: patch,
        },
        async ({ receiptId }) => {
          await tx.query(
            'INSERT INTO "PracticeTrialReviewAssignment"("id","submissionId","evaluatorAccountId","purpose","expiresAt","reason","issuedByAccountId","issuedAt","receiptId","requestId") VALUES($1::uuid,$2::uuid,$3,$4,$5::timestamptz,$6,$7,COALESCE($8::timestamptz,date_trunc(\'milliseconds\',clock_timestamp())),$9::uuid,$10)',
            [
              id,
              patch.subject ?? submissionId,
              patch.evaluator ?? evaluator.accountId,
              patch.purpose ?? body.purpose,
              patch.expiresAt ?? body.expiresAt,
              patch.reason ?? body.reason,
              publisher.accountId,
              patch.issuedAt ?? null,
              receiptId,
              'raw-review',
            ],
          );
          return {
            resultRef: patch.wrongResult ? randomUUID() : id,
            events: patch.noAudit
              ? []
              : [
                  {
                    type: 'skill.practice_review_assignment_issued.v1',
                    aggregateId: id,
                    aggregateVersion: 1,
                    payload: patch.wrongPayload
                      ? { practiceReviewAssignmentId: randomUUID() }
                      : { practiceReviewAssignmentId: id },
                    publish: patch.publish ?? false,
                  },
                ],
          };
        },
      ),
    );
  }
  it('raw SQL valid control commits only with matching finalized receipt and private audit', async () => {
    const r = await rawIssue();
    expect(await use(r.resultRef)).not.toBeNull();
  });
  it.each([
    { purpose: 'ALL' },
    { expiresAt: '2000-01-01T00:00:00.000Z' },
    { expiresAt: 'infinity' },
    { reason: ' ' },
    { reason: '😀'.repeat(1001) },
    { evaluator: 'missing' },
    { subject: '00000000-0000-4000-8000-000000000000' },
    { issuedAt: '2000-01-01T00:00:00.000Z' },
    { issuedAt: '2100-01-01T00:00:00.000Z' },
    { kind: 'WrongCommand' },
    { noAudit: true },
    { publish: true },
    { wrongPayload: true },
    { wrongResult: true },
    { wrongActor: true },
  ])('raw SQL rejects invalid assignment provenance or shape %s', async (patch) => {
    await expect(rawIssue(patch)).rejects.toBeDefined();
    expect(
      await db.$queryRawUnsafe('SELECT count(*)::int AS n FROM "PracticeTrialReviewAssignment"'),
    ).toEqual([{ n: 0 }]);
  });
  it('raw SQL rejects direct self review regardless of host flags', async () => {
    await expect(rawIssue({ evaluator: subject.accountId })).rejects.toBeDefined();
  });
  async function pendingLock(pid: number) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = await db.$queryRawUnsafe<{ waiting: boolean }[]>(
        'SELECT "wait_event_type"=\'Lock\' AS waiting FROM pg_stat_activity WHERE pid=$1',
        pid,
      );
      if (rows[0]?.waiting) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('Expected owned backend to wait on actual PostgreSQL lock');
  }
  it.each(['session', 'assignment'])(
    'checks actual %s expiry after an assignment mutex wait',
    async (boundary) => {
      const g = await issue({
        ...grantInput(),
        expiresAt: new Date(Date.now() + (boundary === 'assignment' ? 1000 : 60000)).toISOString(),
      });
      if (boundary === 'session')
        await db.session.update({
          where: { tokenHash: evaluator.sessionHash },
          data: { expiresAt: new Date(Date.now() + 1000) },
        });
      let unlock!: () => void, locked!: () => void, pidReady!: (pid: number) => void;
      const hold = new Promise<void>((r) => (unlock = r)),
        ready = new Promise<void>((r) => (locked = r)),
        waitingPid = new Promise<number>((r) => (pidReady = r));
      const blocker = runCommandTransaction(db, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,12017))::text', [
          g.assignment.id,
        ]);
        locked();
        await hold;
      });
      await ready;
      const outcome = runCommandTransaction(db, async (tx) => {
        const [row] = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid', []);
        pidReady(row.pid);
        return lockPracticeReviewAssignment(
          tx,
          evaluator,
          { assignmentId: g.assignment.id, submissionId, purpose: 'OWNERSHIP_REVIEW' },
          () => true,
        );
      }).then(
        (value) => ({ value, error: null }),
        (error) => ({ value: null, error }),
      );
      try {
        await pendingLock(await waitingPid);
        await new Promise((r) => setTimeout(r, 1100));
      } finally {
        unlock();
        await blocker;
      }
      const result = await outcome;
      if (boundary === 'session')
        expect(result.error).toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
      else {
        expect(result.error).toBeNull();
        expect(result.value).toBeNull();
      }
    },
  );
  it('observes committed revocation after waiting for actual evaluator user lock', async () => {
    const g = await issue();
    let release!: () => void, held!: () => void, pidReady!: (pid: number) => void;
    const hold = new Promise<void>((r) => (release = r)),
      ready = new Promise<void>((r) => (held = r)),
      waitingPid = new Promise<number>((r) => (pidReady = r));
    const revoking = runCommandTransaction(db, async (tx) => {
      const value = await revokePracticeReviewAssignment(
        tx,
        {
          actor: publisher,
          input: { version: 'v1', assignmentId: g.assignment.id, reason: 'Synthetic race revoke' },
          idempotencyKey: randomUUID(),
          requestId: 'race',
        },
        policy,
      );
      held();
      await hold;
      return value;
    });
    await ready;
    const using = runCommandTransaction(db, async (tx) => {
      const [row] = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid', []);
      pidReady(row.pid);
      return lockPracticeReviewAssignment(
        tx,
        evaluator,
        { assignmentId: g.assignment.id, submissionId, purpose: 'OWNERSHIP_REVIEW' },
        () => true,
      );
    });
    try {
      await pendingLock(await waitingPid);
    } finally {
      release();
      await revoking;
    }
    expect(await using).toBeNull();
  });
});
it.each([
  { reason: ' ' },
  { expiresAt: 'invalid' },
  { expiresAt: '2030-01-01T00:00:00.1234Z' },
  { purpose: 'ALL' },
  { submissionId: 'x' },
  { evaluatorAccountId: '' },
  { extra: true },
])('rejects malformed new assignment before any SQL %s', async (patch) => {
  let queries = 0;
  const tx: CommandReceiptTransaction = {
    dialect: 'POSTGRESQL',
    isolation: 'READ_COMMITTED',
    async query() {
      queries++;
      return [];
    },
  };
  await expect(
    issuePracticeReviewAssignment(
      tx,
      {
        actor: { accountId: 'a', sessionHash: 'a'.repeat(64) },
        input: {
          version: 'v1',
          submissionId: randomUUID(),
          evaluatorAccountId: 'b',
          purpose: 'OWNERSHIP_REVIEW',
          expiresAt: '2030-01-01T00:00:00.000Z',
          reason: 'reason',
          ...patch,
        },
        idempotencyKey: 'k',
        requestId: 'r',
      },
      { allowNewWrites: true, canManage: () => true },
    ),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(queries).toBe(0);
});
