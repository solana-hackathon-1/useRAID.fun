import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/lib/db';
import { hash } from '../src/lib/auth-primitives';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import type { CommandReceiptTransaction } from '../src/command-receipts';
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

import { readPracticeTrialForReview } from '../src/skills/practice-review-read-storage';
let assignmentId: string, originalDefinition: unknown, originalSubmission: unknown;
const readInput = () => ({
  version: 'v1',
  assignmentId,
  submissionId,
  purpose: 'OWNERSHIP_REVIEW',
});
const review = (
  body: unknown = readInput(),
  a = evaluator,
  canRead: Parameters<typeof readPracticeTrialForReview>[3] = () => true,
) => runCommandTransaction(db, (tx) => readPracticeTrialForReview(tx, a, body, canRead));
integration('T013D2 protected private practice reviewer reads', () => {
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
    originalDefinition = begun.start.definition;
    const saved = await submit();
    submissionId = saved.submission.reference.recordId;
    originalSubmission = saved.submission;
    assignmentId = (await issue()).assignment.id;
  });
  afterAll(() => db.$disconnect());
  it('returns exact private immutable submission, original full definition/rubric and actual assignment, never confirmation', async () => {
    const r = await review();
    expect(r).toMatchObject({
      version: 'v1',
      private: true,
      isAuthorizationToken: false,
      assignment: { id: assignmentId, submissionId, purpose: 'OWNERSHIP_REVIEW' },
      submission: {
        ownership: 'UNCONFIRMED',
        verifiesSkill: false,
        createsPermissionGrant: false,
        consumesCapacity: false,
        createsFinancialObligation: false,
      },
    });
    expect(r?.submission).toEqual(originalSubmission);
    expect(r?.definition).toEqual(originalDefinition);
    expect(r?.submission.answer).toBe(input().answer);
  });
  it('preserves original accepted consent and bytes after definition retirement/new writes disabled', async () => {
    await publish(1, 'RETIRED');
    expect(await use(assignmentId)).not.toBeNull();
    const r = await review();
    expect(r?.definition).toEqual(originalDefinition);
    expect(r?.submission).toEqual(originalSubmission);
  });
  it.each([
    'missing-assignment',
    'missing-submission',
    'wrong-submission',
    'wrong-purpose',
    'subject',
    'admin',
    'other-evaluator',
    'revoked',
  ])('denies %s before any private-column query', async (denial) => {
    let a = evaluator,
      body = readInput();
    if (denial === 'missing-assignment') body = { ...body, assignmentId: randomUUID() };
    if (denial === 'missing-submission') body = { ...body, submissionId: randomUUID() };
    if (denial === 'wrong-submission') {
      const foreign = await actor();
      const foreignStart = await begin(foreign);
      const foreignSubmission = await submit(
        foreign,
        {
          ...input(),
          startId: foreignStart.start.id,
          answer: 'Synthetic foreign private marker.',
        },
        randomUUID(),
      );
      body = { ...body, submissionId: foreignSubmission.submission.reference.recordId };
    }
    if (denial === 'wrong-purpose') body = { ...body, purpose: 'ASSESSMENT_REVIEW' };
    if (denial === 'subject') a = subject;
    if (denial === 'admin') a = publisher;
    if (denial === 'other-evaluator') a = await actor(false, false);
    if (denial === 'revoked') await revoke(assignmentId);
    let privateQueries = 0;
    const r = await runCommandTransaction(db, (tx) =>
      readPracticeTrialForReview(
        {
          ...tx,
          async query<Row>(sql: string, bindings: readonly (string | null)[]) {
            if (sql.includes('"answer"')) privateQueries++;
            return tx.query<Row>(sql, bindings);
          },
        },
        a,
        body,
        () => true,
      ),
    );
    expect(r).toBeNull();
    expect(privateQueries).toBe(0);
  });
  it.each([false, undefined, 'true'])(
    'requires exact true current read policy: %s',
    async (value) => {
      let privateQueries = 0;
      expect(
        await runCommandTransaction(db, (tx) =>
          readPracticeTrialForReview(
            {
              ...tx,
              async query<Row>(sql: string, bindings: readonly (string | null)[]) {
                if (sql.includes('"answer"')) privateQueries++;
                return tx.query<Row>(sql, bindings);
              },
            },
            evaluator,
            readInput(),
            () => value as boolean,
          ),
        ),
      ).toBeNull();
      expect(privateQueries).toBe(0);
    },
  );
  it.each(['suspended', 'expired', 'deleted', 'foreign-session'])(
    'requires current evaluator own identity %s',
    async (change) => {
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
      await expect(review(readInput(), a)).rejects.toMatchObject({
        code: change === 'suspended' ? 'ACCOUNT_RESTRICTED' : 'AUTHENTICATION_REQUIRED',
      });
    },
  );
  it('does not return a loaded private body after current read policy changes during the query', async () => {
    let allowed = true,
      privateQueries = 0;
    const r = await runCommandTransaction(db, (tx) =>
      readPracticeTrialForReview(
        {
          ...tx,
          async query<Row>(sql: string, bindings: readonly (string | null)[]) {
            const rows = await tx.query<Row>(sql, bindings);
            if (sql.includes('"answer"')) {
              allowed = false;
              privateQueries++;
            }
            return rows;
          },
        },
        evaluator,
        readInput(),
        () => allowed,
      ),
    );
    expect(privateQueries).toBe(1);
    expect(r).toBeNull();
  });
  it('sanitizes thrown scoped policy exceptions and never returns private details', async () => {
    const work = review(readInput(), evaluator, () => {
      throw new Error('private-policy-marker');
    });
    await expect(work).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await expect(work).rejects.not.toThrow('private-policy-marker');
  });
  it('records a private identifier-only authorized case-access attempt before private columns, without business/outbox changes', async () => {
    const [before] = await db.$queryRawUnsafe<
      { receipts: number; audits: number; outbox: number }[]
    >(
      'SELECT (SELECT count(*)::int FROM "CommandReceipt") receipts,(SELECT count(*)::int FROM "AuditEvent") audits,(SELECT count(*)::int FROM "OutboxEvent") outbox',
    );
    let observed = false;
    const result = await runCommandTransaction(db, (tx) =>
      readPracticeTrialForReview(
        {
          ...tx,
          async query<Row>(sql: string, bindings: readonly (string | null)[]) {
            if (sql.includes('"answer"')) {
              const rows = await tx.query<{
                actorId: string;
                aggregateId: string;
                payload: unknown;
                correlationId: string;
              }>(
                `SELECT "actorId","aggregateId","payload","correlationId" FROM "AuditEvent" WHERE "eventType"='skill.practice_review_access_authorized.v1'`,
                [],
              );
              expect(rows).toHaveLength(1);
              expect(rows[0]).toMatchObject({
                actorId: evaluator.accountId,
                aggregateId: submissionId,
                payload: { practiceReviewAssignmentId: assignmentId },
              });
              observed = true;
            }
            return tx.query<Row>(sql, bindings);
          },
        },
        evaluator,
        readInput(),
        () => true,
      ),
    );
    expect(observed).toBe(true);
    expect(result?.submission).toEqual(originalSubmission);
    const [after] = await db.$queryRawUnsafe<
      { receipts: number; audits: number; outbox: number }[]
    >(
      'SELECT (SELECT count(*)::int FROM "CommandReceipt") receipts,(SELECT count(*)::int FROM "AuditEvent") audits,(SELECT count(*)::int FROM "OutboxEvent") outbox',
    );
    expect(after).toEqual({
      receipts: before.receipts + 1,
      audits: before.audits + 1,
      outbox: before.outbox,
    });
    const [event] = await db.$queryRawUnsafe<{ payload: unknown; correlationId: string }[]>(
      `SELECT "payload","correlationId" FROM "AuditEvent" WHERE "eventType"='skill.practice_review_access_authorized.v1'`,
    );
    expect(event.correlationId).toBe(result?.accessId);
    expect(JSON.stringify(event)).not.toContain(input().answer);
  });
  it('fails closed before selecting private bytes if the required case-access audit cannot persist', async () => {
    let privateQueries = 0;
    const work = runCommandTransaction(db, (tx) =>
      readPracticeTrialForReview(
        {
          ...tx,
          async query<Row>(sql: string, bindings: readonly (string | null)[]) {
            if (sql.includes('INSERT INTO "AuditEvent"'))
              throw new Error('private-audit-driver-marker');
            if (sql.includes('"answer"')) privateQueries++;
            return tx.query<Row>(sql, bindings);
          },
        },
        evaluator,
        readInput(),
        () => true,
      ),
    );
    await expect(work).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await expect(work).rejects.not.toThrow('private-audit-driver-marker');
    expect(privateQueries).toBe(0);
  });
  it.each(['answer', 'definition'])(
    'rejects malformed host %s projections after permission without returning body',
    async (field) => {
      await expect(
        runCommandTransaction(db, (tx) =>
          readPracticeTrialForReview(
            {
              ...tx,
              async query<Row>(sql: string, bindings: readonly (string | null)[]) {
                const rows = await tx.query<Row>(sql, bindings);
                return sql.includes('"answer"') ? rows.map((r) => ({ ...r, [field]: null })) : rows;
              },
            },
            evaluator,
            readInput(),
            () => true,
          ),
        ),
      ).rejects.toMatchObject({ code: 'STORAGE_CONTRACT' });
    },
  );
  it('returns SQL-shaped submitted code literally and never executes it', async () => {
    const start = await begin(),
      answer = 'DROP TABLE "User"; SELECT pg_sleep(100); -- literal private answer';
    const saved = await submit(
      subject,
      { ...input(), startId: start.start.id, answer },
      randomUUID(),
    );
    const g = await issue({ ...grantInput(), submissionId: saved.submission.reference.recordId });
    const before = await db.user.count(),
      r = await review({
        version: 'v1',
        assignmentId: g.assignment.id,
        submissionId: saved.submission.reference.recordId,
        purpose: 'OWNERSHIP_REVIEW',
      });
    expect(r?.submission.answer).toBe(answer);
    expect(await db.user.count()).toBe(before);
  });
  it('allows an explicitly assigned assessment purpose without claiming assessed rank', async () => {
    const g = await issue({ ...grantInput(), purpose: 'ASSESSMENT_REVIEW' });
    const r = await review({
      ...readInput(),
      assignmentId: g.assignment.id,
      purpose: 'ASSESSMENT_REVIEW',
    });
    expect(r?.submission.ownership).toBe('UNCONFIRMED');
    expect(r?.submission.verifiesSkill).toBe(false);
  });
  it('sanitizes private driver failures and rejects noncanonical tool projections', async () => {
    for (const bad of ['driver', 'tools']) {
      const work = runCommandTransaction(db, (tx) =>
        readPracticeTrialForReview(
          {
            ...tx,
            async query<Row>(sql: string, bindings: readonly (string | null)[]) {
              if (sql.includes('"answer"')) {
                if (bad === 'driver') throw new Error('private-driver-marker');
                const rows = await tx.query<Row>(sql, bindings);
                return rows.map((r) => ({ ...r, toolsUsed: [' editor '] }));
              }
              return tx.query<Row>(sql, bindings);
            },
          },
          evaluator,
          readInput(),
          () => true,
        ),
      );
      await expect(work).rejects.toMatchObject({
        code: bad === 'driver' ? 'STORAGE_UNAVAILABLE' : 'STORAGE_CONTRACT',
      });
      await expect(work).rejects.not.toThrow('private-driver-marker');
    }
  });
  async function pendingPrivateLock(pid: number) {
    for (let i = 0; i < 100; i++) {
      const [row] = await db.$queryRawUnsafe<{ waiting: boolean }[]>(
        "SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",
        pid,
      );
      if (row?.waiting) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('Expected owned private-query backend to wait on actual PostgreSQL lock');
  }
  it.each(['session', 'assignment'])(
    'does not return private bytes after actual %s expiry during protected query wait',
    async (boundary) => {
      if (boundary === 'assignment')
        assignmentId = (
          await issue({ ...grantInput(), expiresAt: new Date(Date.now() + 2000).toISOString() })
        ).assignment.id;
      if (boundary === 'session')
        await db.session.update({
          where: { tokenHash: evaluator.sessionHash },
          data: { expiresAt: new Date(Date.now() + 2000) },
        });
      let release!: () => void, locked!: () => void, pidReady!: (id: number) => void;
      const hold = new Promise<void>((r) => (release = r)),
        ready = new Promise<void>((r) => (locked = r)),
        waitingPid = new Promise<number>((r) => (pidReady = r));
      const blocker = runCommandTransaction(db, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,12021))::text', [
          assignmentId,
        ]);
        locked();
        await hold;
      });
      await ready;
      let privateQueries = 0;
      const reading = runCommandTransaction(db, (tx) =>
        readPracticeTrialForReview(
          {
            ...tx,
            async query<Row>(sql: string, bindings: readonly (string | null)[]) {
              if (sql.includes('"answer"')) {
                const [row] = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid', []);
                pidReady(row.pid);
                await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,12021))::text', [
                  assignmentId,
                ]);
                privateQueries++;
              }
              return tx.query<Row>(sql, bindings);
            },
          },
          evaluator,
          readInput(),
          () => true,
        ),
      ).then(
        (value) => ({ value, error: null }),
        (error) => ({ value: null, error }),
      );
      try {
        await pendingPrivateLock(await waitingPid);
        await new Promise((r) => setTimeout(r, 2100));
      } finally {
        release();
        await blocker;
      }
      const r = await reading;
      expect(privateQueries).toBe(1);
      expect(r.value).toBeNull();
      if (boundary === 'session')
        expect(r.error).toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
      else expect(r.error).toBeNull();
    },
  );
});
it.each([{ version: 'v2' }, { submissionId: 'bad' }, { purpose: 'ALL' }, { extra: true }])(
  'rejects malformed review input before queries %s',
  async (patch) => {
    let calls = 0;
    const tx: CommandReceiptTransaction = {
      dialect: 'POSTGRESQL',
      isolation: 'READ_COMMITTED',
      async query() {
        calls++;
        return [];
      },
    };
    await expect(
      readPracticeTrialForReview(
        tx,
        { accountId: 'a', sessionHash: 'a'.repeat(64) },
        {
          version: 'v1',
          assignmentId: randomUUID(),
          submissionId: randomUUID(),
          purpose: 'OWNERSHIP_REVIEW',
          ...patch,
        },
        () => true,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(calls).toBe(0);
  },
);
