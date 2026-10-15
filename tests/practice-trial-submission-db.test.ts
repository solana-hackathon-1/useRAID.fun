import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { db } from '../src/lib/db';
import { hash } from '../src/lib/auth-primitives';
import {
  runCommandTransaction,
  createPrismaCommandTransaction,
} from '../src/lib/command-receipts-adapter';
import { executeIdempotentCommand } from '../src/command-receipts';
import { publishSkillTaxonomy, type SkillTaxonomyActor } from '../src/skills/taxonomy-storage';
import { publishPracticeTrialDefinition } from '../src/skills/practice-trial-storage';
import {
  startPracticeTrial,
  lockPracticeTrialParticipant,
} from '../src/skills/practice-trial-attempt-storage';
import {
  submitPracticeTrial,
  readPracticeTrialSubmission,
  PracticeTrialSubmissionStorageError,
} from '../src/skills/practice-trial-submission-storage';
import { SkillAssessmentSnapshotSchema } from '../src/skills/assessment-review-contracts';
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
const read = (id: string, a = subject) =>
  runCommandTransaction(db, (tx) => readPracticeTrialSubmission(tx, a, id));
const counts = () =>
  db.$queryRawUnsafe(
    `SELECT (SELECT count(*)::int FROM "PracticeTrialSubmission") submissions,(SELECT count(*)::int FROM "PracticeTrialStart") starts,(SELECT count(*)::int FROM "CommandReceipt") receipts,(SELECT count(*)::int FROM "AuditEvent") audits,(SELECT count(*)::int FROM "OutboxEvent") outbox,(SELECT count(*)::int FROM "Participant") participants`,
  );
integration('T013C3 durable private practice submissions', () => {
  let locker: PrismaClient, observer: PrismaClient;
  beforeAll(() => {
    assertTestDatabase();
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('connection_limit', '1');
    locker = new PrismaClient({
      datasourceUrl: url.toString(),
      transactionOptions: { timeout: 15000, maxWait: 10000 },
    });
    observer = new PrismaClient({ datasourceUrl: url.toString() });
  });
  beforeEach(async () => {
    await truncateAll(db);
    publisher = await actor(true, false);
    subject = await actor();
    await publishCatalog();
    await publish();
    const value = await begin();
    startId = value.start.id;
    participantId = value.start.participantId;
  });
  afterAll(() => Promise.all([db.$disconnect(), locker?.$disconnect(), observer?.$disconnect()]));
  it('saves exact original consent and text whitespace as immutable private unconfirmed submission, never assessment', async () => {
    const saved = await submit();
    expect(saved.status).toBe('EXECUTED');
    expect(saved.submission).toMatchObject({
      version: 'v1',
      reference: { revision: 1 },
      startId,
      participantId,
      definitionReference: input().expectedDefinitionReference,
      rubricReference: input().expectedRubricReference,
      state: 'SUBMITTED',
      answer: input().answer,
      explanation: input().explanation,
      toolsUsed: ['editor'],
      aiAssistanceUsed: false,
      ownership: 'UNCONFIRMED',
      persisted: true,
      verifiesSkill: false,
      isAuthorizationToken: false,
      createsPermissionGrant: false,
      consumesCapacity: false,
      createsFinancialObligation: false,
    });
    expect(Object.isFrozen(saved.submission)).toBe(true);
    expect(SkillAssessmentSnapshotSchema.safeParse(saved.submission).success).toBe(false);
    expect(await read(saved.submission.reference.recordId)).toEqual(saved.submission);
    expect(await counts()).toEqual([
      { submissions: 1, starts: 1, receipts: 4, audits: 4, outbox: 0, participants: 1 },
    ]);
  });
  it('reuses actual locked immutable own canonical participant without autoprovision', async () => {
    const own = await runCommandTransaction(db, (tx) => lockPracticeTrialParticipant(tx, subject));
    expect(own).toEqual({ id: participantId, accountId: subject.accountId, kind: 'HUMAN' });
    expect(Object.isFrozen(own)).toBe(true);
    const missing = await actor(false, false);
    await expect(
      runCommandTransaction(db, (tx) => lockPracticeTrialParticipant(tx, missing)),
    ).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
  });
  it.each([
    'participantId',
    'ownership',
    'assessedRank',
    'submittedAt',
    'reference',
    'evidenceReferences',
    'persisted',
  ])('rejects caller-forged %s without consuming anything', async (field) => {
    await expect(submit(subject, { ...input(), [field]: 'forged' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
  it.each(['expectedDefinitionReference', 'expectedRubricReference'])(
    'binds %s to the actual immutable accepted start',
    async (field) => {
      const body = input();
      await expect(
        submit(subject, { ...body, [field]: { ...body.expectedDefinitionReference, revision: 2 } }),
      ).rejects.toMatchObject({ code: 'REVISION_CHANGED' });
    },
  );
  it('keeps foreign and unknown starts unavailable and private submission IDs undisclosed', async () => {
    const other = await actor();
    await expect(submit(other)).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
    await expect(submit(subject, { ...input(), startId: randomUUID() })).rejects.toMatchObject({
      code: 'RESOURCE_UNAVAILABLE',
    });
    const saved = await submit();
    expect(await read(saved.submission.reference.recordId, other)).toBeNull();
    expect(await read(randomUUID())).toBeNull();
  });
  it.each(['expired', 'revoked', 'foreign', 'unsupported'])(
    'rejects a %s current session with complete rollback',
    async (mode) => {
      const before = await counts();
      if (mode === 'expired')
        await db.session.update({
          where: { tokenHash: subject.sessionHash },
          data: { expiresAt: new Date(0) },
        });
      if (mode === 'revoked')
        await db.session.delete({ where: { tokenHash: subject.sessionHash } });
      if (mode === 'foreign') subject = { ...subject, sessionHash: publisher.sessionHash };
      if (mode === 'unsupported')
        await db.session.update({
          where: { tokenHash: subject.sessionHash },
          data: { via: 'unsupported' },
        });
      await expect(submit()).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
      expect(await counts()).toEqual(before);
    },
  );
  it('denies current suspension on new intent, original replay and private reads', async () => {
    const key = randomUUID(),
      saved = await submit(subject, input(), key),
      before = await counts();
    await db.user.update({ where: { id: subject.accountId }, data: { suspended: true } });
    await expect(submit()).rejects.toMatchObject({ code: 'ACCOUNT_RESTRICTED' });
    await expect(submit(subject, input(), key)).rejects.toMatchObject({
      code: 'ACCOUNT_RESTRICTED',
    });
    await expect(read(saved.submission.reference.recordId)).rejects.toMatchObject({
      code: 'ACCOUNT_RESTRICTED',
    });
    expect(await counts()).toEqual(before);
  });
  it('finishes an accepted start after definition and catalog retirement without rewriting original consent', async () => {
    await publish(1, 'RETIRED');
    await publishCatalog(1, [{ ...skills[0], status: 'RETIRED' }]);
    const saved = await submit();
    expect(saved.submission).toMatchObject({
      definitionReference: input().expectedDefinitionReference,
      rubricReference: input().expectedRubricReference,
    });
  });
  it('preserves original receipt after retirement/disablement and denies only new intent', async () => {
    const key = randomUUID(),
      saved = await submit(subject, input(), key);
    await publish(1, 'RETIRED');
    const before = await counts();
    expect(await submit(subject, input(), key, false)).toEqual({
      status: 'REPLAYED',
      submission: saved.submission,
    });
    await expect(submit(subject, input(), randomUUID(), false)).rejects.toMatchObject({
      code: 'WRITES_DISABLED',
    });
    expect(await counts()).toEqual(before);
  });
  it('distinguishes exact code whitespace in original intent and reauthorizes changed-key conflicts', async () => {
    const key = randomUUID();
    await submit(subject, input(), key);
    const before = await counts();
    await expect(
      submit(subject, { ...input(), answer: input().answer + ' ' }, key),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await db.session.delete({ where: { tokenHash: subject.sessionHash } });
    await expect(submit(subject, { ...input(), answer: 'changed' }, key)).rejects.toMatchObject({
      code: 'AUTHENTICATION_REQUIRED',
    });
    expect(await counts()).toEqual(before);
  });
  it('serializes duplicate intent into one exact original private submission', async () => {
    const key = randomUUID(),
      values = await Promise.all([submit(subject, input(), key), submit(subject, input(), key)]);
    expect(values.map((v) => v.status).sort()).toEqual(['EXECUTED', 'REPLAYED']);
    expect(values[0].submission).toEqual(values[1].submission);
    expect(await counts()).toEqual([
      { submissions: 1, starts: 1, receipts: 4, audits: 4, outbox: 0, participants: 1 },
    ]);
  });
  it('allows only one final submission per saved start under concurrent different keys', async () => {
    const values = await Promise.allSettled([submit(), submit()]);
    expect(values.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
    for (const value of values)
      if (value.status === 'rejected')
        expect(value.reason).toMatchObject({ code: 'ALREADY_SUBMITTED' });
    expect(await counts()).toEqual([
      { submissions: 1, starts: 1, receipts: 4, audits: 4, outbox: 0, participants: 1 },
    ]);
  });
  it('keeps submissions for separately authorized family attempts independent', async () => {
    const first = await submit(),
      secondStart = await begin(),
      second = await submit(subject, {
        ...input(),
        startId: secondStart.start.id,
        answer: 'A separate invented response.',
      });
    expect(second.submission.reference.recordId).not.toBe(first.submission.reference.recordId);
    expect(await read(first.submission.reference.recordId)).toEqual(first.submission);
  });
  it('never puts private answers, explanations or assistance declarations in audit/outbox/receipts', async () => {
    const marker = 'PRIVATE-SYNTHETIC-' + randomUUID();
    await submit(subject, {
      ...input(),
      answer: marker,
      explanation: marker,
      assistanceDisclosure: marker,
    });
    const events = await db.$queryRawUnsafe(
      `SELECT row_to_json(a)::text AS value FROM "AuditEvent" a UNION ALL SELECT row_to_json(o)::text FROM "OutboxEvent" o UNION ALL SELECT row_to_json(c)::text FROM "CommandReceipt" c`,
    );
    expect(JSON.stringify(events)).not.toContain(marker);
    expect(await db.mediaAsset.count()).toBe(0);
  });
  it.each(['\u0000', '\ud800', '   \r\n'])(
    'rejects unsupported or empty-visible answer text %j before any effect',
    async (answer) => {
      const before = await counts();
      await expect(submit(subject, { ...input(), answer })).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      expect(await counts()).toEqual(before);
    },
  );
  it('preserves valid supplementary Unicode at the exact UTF16 bound and rejects overflow', async () => {
    const answer = '😀'.repeat(20000),
      saved = await submit(subject, { ...input(), answer });
    expect(saved.submission.answer).toBe(answer);
    const next = await begin(),
      before = await counts();
    await expect(
      submit(subject, { ...input(), startId: next.start.id, answer: answer + '😀' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await counts()).toEqual(before);
  });
  it('observes actual session expiry while waiting on the submission mutex', async () => {
    let release!: () => void, acquired!: () => void;
    const ready = new Promise<void>((r) => {
        acquired = r;
      }),
      held = new Promise<void>((r) => {
        release = r;
      });
    const lock = locker.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,12016))::text',
        startId,
      );
      acquired();
      await held;
    });
    await ready;
    let work: Promise<unknown> | undefined;
    try {
      await db.session.update({
        where: { tokenHash: subject.sessionHash },
        data: { expiresAt: new Date(Date.now() + 400) },
      });
      work = expect(submit()).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
      void work.catch(() => {});
      const deadline = Date.now() + 2000;
      let blocked = false;
      while (Date.now() < deadline) {
        const [row] = await observer.$queryRawUnsafe<{ waiting: boolean }[]>(
          `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0) AS waiting`,
        );
        if (row.waiting) {
          blocked = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(blocked).toBe(true);
      await new Promise((r) => setTimeout(r, 450));
    } finally {
      release();
      await lock;
      if (work) await work;
    }
    expect(await counts()).toEqual([
      { submissions: 0, starts: 1, receipts: 3, audits: 3, outbox: 0, participants: 1 },
    ]);
  });
  it('normalizes current owner-reader denials to its owned error while retaining authentication code', async () => {
    await db.session.update({
      where: { tokenHash: subject.sessionHash },
      data: { expiresAt: new Date(Date.now() + 400) },
    });
    let observed = false;
    const work = runCommandTransaction(db, (port) =>
      submitPracticeTrial(
        {
          ...port,
          async query<Row>(sql: string, bindings: readonly (string | null)[]) {
            if (sql.includes('FROM "PracticeTrialStart" s JOIN "PracticeTrialVersion"')) {
              observed = true;
              await port.query('SELECT pg_sleep(0.5)::text', []);
            }
            return port.query<Row>(sql, bindings);
          },
        },
        {
          actor: subject,
          input: input(),
          idempotencyKey: randomUUID(),
          requestId: 'synthetic-owner-expiry',
        },
        { allowNewWrites: true },
      ),
    );
    await expect(work).rejects.toBeInstanceOf(PracticeTrialSubmissionStorageError);
    await expect(work).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
    expect(observed).toBe(true);
  });
  type Probe = {
    answer?: string;
    explanation?: string;
    disclosure?: string;
    tools?: unknown;
    revision?: number;
    start?: string;
    participant?: string;
    account?: string;
    time?: string;
    kind?: string;
    receiptActor?: string;
    request?: string;
    aggregate?: string;
    payload?: Record<string, string>;
    publish?: boolean;
    omitAudit?: boolean;
    failAfterInsert?: boolean;
  };
  function direct(patch: Probe = {}) {
    return db.$transaction(async (raw) =>
      executeIdempotentCommand(
        createPrismaCommandTransaction(raw),
        {
          actorId: patch.receiptActor ?? subject.accountId,
          commandKind: patch.kind ?? 'SubmitPracticeTrial',
          idempotencyKey: randomUUID(),
          requestId: 'synthetic-raw-submit',
          request: { synthetic: true },
        },
        async ({ receiptId }) => {
          const [clock] = await raw.$queryRawUnsafe<{ now: Date }[]>(
            `SELECT date_trunc('milliseconds',clock_timestamp()) AS now`,
          );
          const id = randomUUID(),
            body = input();
          await raw.$executeRawUnsafe(
            `INSERT INTO "PracticeTrialSubmission"("id","revision","startId","participantId","accountId","answer","explanation","toolsUsed","aiAssistanceUsed","assistanceDisclosure","submittedAt","receiptId","requestId") VALUES($1::uuid,$2::int,$3::uuid,$4::uuid,$5,$6,$7,$8::jsonb,false,$9,$10::timestamptz,$11::uuid,$12)`,
            id,
            patch.revision ?? 1,
            patch.start ?? startId,
            patch.participant ?? participantId,
            patch.account ?? subject.accountId,
            patch.answer ?? body.answer,
            patch.explanation ?? body.explanation,
            JSON.stringify(Object.hasOwn(patch, 'tools') ? patch.tools : body.toolsUsed),
            patch.disclosure ?? body.assistanceDisclosure,
            patch.time ?? clock.now.toISOString(),
            receiptId,
            patch.request ?? 'synthetic-raw-submit',
          );
          if (patch.failAfterInsert) throw Error('Synthetic post-insert failure');
          return {
            resultRef: id,
            events: patch.omitAudit
              ? []
              : [
                  {
                    type: 'skill.practice_trial_submitted.v1',
                    aggregateId: patch.aggregate ?? id,
                    aggregateVersion: 1,
                    payload: patch.payload ?? { practiceTrialSubmissionId: id },
                    publish: patch.publish ?? false,
                  },
                ],
          };
        },
      ),
    );
  }
  it('has a valid privileged SQL control preserving exact response bytes and canonical original start', async () => {
    const saved = await direct();
    expect(saved.status).toBe('EXECUTED');
    expect(await read(saved.resultRef)).toMatchObject({
      reference: { recordId: saved.resultRef, revision: 1 },
      answer: input().answer,
      participantId,
      startId,
      ownership: 'UNCONFIRMED',
    });
  });
  it.each([
    ['wrong immutable revision', { revision: 2 }],
    ['empty answer', { answer: '' }],
    ['invisible answer', { answer: '\uFEFF \r\n' }],
    ['ASCII answer overflow', { answer: 'x'.repeat(40001) }],
    ['Unicode answer overflow', { answer: '😀'.repeat(20001) }],
    ['Unicode explanation overflow', { explanation: '😀'.repeat(2001) }],
    ['Unicode disclosure overflow', { disclosure: '😀'.repeat(2001) }],
    ['null tools', { tools: null }],
    ['object tools', { tools: { tool: 'editor' } }],
    ['non-string tool', { tools: [true] }],
    ['duplicate tools', { tools: ['editor', 'editor'] }],
    ['noncanonical tool label', { tools: [' editor '] }],
    ['Unicode tool overflow', { tools: ['😀'.repeat(101)] }],
    ['foreign start', { start: randomUUID() }],
    ['foreign participant', { participant: randomUUID() }],
    ['foreign account', { account: 'absent' }],
    ['future time', { time: '2099-01-01T00:00:00Z' }],
    ['backdated time', { time: '2020-01-01T00:00:00Z' }],
    ['wrong command', { kind: 'StartPracticeTrial' }],
    ['wrong receipt actor', { receiptActor: 'absent' }],
    ['wrong request', { request: 'another-request' }],
    ['wrong aggregate', { aggregate: randomUUID() }],
    ['public outbox', { publish: true }],
    [
      'private audit payload',
      { payload: { practiceTrialSubmissionId: 'wrong', answer: 'synthetic-private' } },
    ],
    ['missing audit', { omitAudit: true }],
    ['late failure', { failAfterInsert: true }],
  ] satisfies [string, Probe][])(
    'rejects privileged SQL %s with complete rollback',
    async (_name, patch) => {
      const before = await counts();
      await expect(direct(patch)).rejects.toBeDefined();
      expect(await counts()).toEqual(before);
    },
  );
  it.each([
    'UPDATE "PracticeTrialSubmission" SET "answer"=\'changed\' WHERE "id"=$1::uuid',
    'UPDATE "PracticeTrialSubmission" SET "id"="id" WHERE "id"=$1::uuid',
    'DELETE FROM "PracticeTrialSubmission" WHERE "id"=$1::uuid',
  ])('retains immutable exact private history: %s', async (sql) => {
    const saved = await submit(),
      before = await counts();
    await expect(
      db.$executeRawUnsafe(sql, saved.submission.reference.recordId),
    ).rejects.toBeDefined();
    expect(await counts()).toEqual(before);
    expect(await read(saved.submission.reference.recordId)).toEqual(saved.submission);
  });
  it('keeps a declared tool deviation unconfirmed without rewriting the approved policy or issuing rank', async () => {
    const saved = await submit(subject, {
      ...input(),
      toolsUsed: ['unlisted-tool'],
      aiAssistanceUsed: true,
      assistanceDisclosure: 'Synthetic disclosure of a tool outside the listed set.',
    });
    expect(saved.submission).toMatchObject({
      toolsUsed: ['unlisted-tool'],
      aiAssistanceUsed: true,
      ownership: 'UNCONFIRMED',
      verifiesSkill: false,
    });
    const [original] = await db.$queryRawUnsafe<{ tools: unknown }[]>(
      `SELECT "definition"->'tools' AS tools FROM "PracticeTrialVersion" WHERE "trialId"=$1 AND "revision"=1`,
      trialId,
    );
    expect(original.tools).toMatchObject({ permitted: ['editor', 'browser'] });
  });

  it('does not treat an admin role as private access to another canonical participant', async () => {
    const saved = await submit(),
      admin = await actor(true, true);
    expect(await read(saved.submission.reference.recordId, admin)).toBeNull();
    await expect(submit(admin)).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
  });
  it('keeps SQL-shaped answer text literal and leaves other entities intact', async () => {
    const answer = '\'); DROP TABLE "User" CASCADE; --',
      before = await db.user.count(),
      saved = await submit(subject, { ...input(), answer });
    expect(saved.submission.answer).toBe(answer);
    expect(await db.user.count()).toBe(before);
  });
  it('denies revoked-session original replay and private reads without erasing history', async () => {
    const key = randomUUID(),
      saved = await submit(subject, input(), key),
      before = await counts();
    await db.session.delete({ where: { tokenHash: subject.sessionHash } });
    await expect(submit(subject, input(), key, false)).rejects.toMatchObject({
      code: 'AUTHENTICATION_REQUIRED',
    });
    await expect(read(saved.submission.reference.recordId)).rejects.toMatchObject({
      code: 'AUTHENTICATION_REQUIRED',
    });
    expect(await counts()).toEqual(before);
  });
});
