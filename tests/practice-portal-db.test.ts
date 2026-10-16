import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/lib/db';
import { hash } from '../src/lib/auth-primitives';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { publishSkillTaxonomy, type SkillTaxonomyActor } from '../src/skills/taxonomy-storage';
import { publishPracticeTrialDefinition } from '../src/skills/practice-trial-storage';
import { startPracticeTrial } from '../src/skills/practice-trial-attempt-storage';
import { submitPracticeTrial } from '../src/skills/practice-trial-submission-storage';
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
import {
  listOwnPracticeTrials,
  readOwnPracticeTrialProgress,
} from '../src/skills/practice-portal-storage';
const browse = (a = subject, after: string | null = null, canRead = () => true) =>
  runCommandTransaction(db, (tx) =>
    listOwnPracticeTrials(tx, a, { version: 'v1', taxonomyId: catalogId, after }, canRead),
  );
const progress = (id = startId, a = subject, canRead = () => true) =>
  runCommandTransaction(db, (tx) => readOwnPracticeTrialProgress(tx, a, id, canRead));
integration('T013D8 actual own practice discovery/progress', () => {
  beforeAll(() => assertTestDatabase());
  beforeEach(async () => {
    await truncateAll(db);
    publisher = await actor(true, false);
    subject = await actor();
    await publishCatalog();
    await publish();
    const s = await begin();
    startId = s.start.id;
    participantId = s.start.participantId;
  });
  afterAll(() => db.$disconnect());
  it('lists only current active trusted-catalog definitions without publisher or private answer fields', async () => {
    const v = await browse();
    expect(v.trials).toHaveLength(1);
    expect(v.trials[0]).toMatchObject({
      availability: 'AVAILABLE',
      taxonomyReference: { recordId: catalogId, revision: 1 },
      definition: { reference: { recordId: trialId, revision: 1 } },
    });
    expect(v.trials[0]).not.toHaveProperty('publishedByAccountId');
    expect(v.nextCursor).toBeNull();
    expect(JSON.stringify(v)).not.toContain('answer');
  });
  it('filters current retirement and uses original accepted definition for owned progress', async () => {
    await publish(1, 'RETIRED');
    expect((await browse()).trials).toEqual([]);
    const v = await progress();
    expect(v).toMatchObject({
      version: 'v1',
      progress: 'STARTED',
      start: { id: startId, definition: { reference: { revision: 1 } } },
      submission: null,
    });
  });
  it('returns exact private saved submission/current progress without rewriting original consent', async () => {
    const saved = await submit();
    const v = await progress();
    if (!v?.submission) throw Error('Expected actual saved own submission');
    expect(v.progress).toBe('SUBMITTED');
    expect(v.start.state).toBe('STARTED');
    expect(v.submission).toEqual(saved.submission);
    expect(v.submission.answer).toBe(input().answer);
    expect(v.submission.ownership).toBe('UNCONFIRMED');
  });
  it('hides foreign and absent starts identically before selecting private answer columns', async () => {
    await submit();
    const foreign = await actor();
    expect(await progress(startId, foreign)).toBeNull();
    expect(await progress(randomUUID())).toBeNull();
  });
  it('requires own canonical current session for both discovery and private read', async () => {
    await db.session.delete({ where: { tokenHash: subject.sessionHash } });
    await expect(browse()).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
    await expect(progress()).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
  });
  it('does not substitute retired taxonomy skills or a foreign catalog', async () => {
    await publishCatalog(1, [{ ...skills[0], status: 'RETIRED' }]);
    expect((await browse()).trials).toEqual([]);
    await expect(
      runCommandTransaction(db, (tx) =>
        listOwnPracticeTrials(
          tx,
          subject,
          { version: 'v1', taxonomyId: 'foreign', after: null },
          () => true,
        ),
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
  });
  it('rechecks scope after source reads and fails closed on policy exceptions', async () => {
    let calls = 0;
    await expect(browse(subject, null, () => ++calls < 3)).rejects.toMatchObject({
      code: 'RESOURCE_UNAVAILABLE',
    });
    await expect(
      progress(startId, subject, () => {
        throw Error('private host detail');
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
  });
  it('uses exclusive lexical pagination and rejects forged participant selectors', async () => {
    expect((await browse(subject, trialId)).trials).toEqual([]);
    await expect(
      runCommandTransaction(db, (tx) =>
        listOwnPracticeTrials(
          tx,
          subject,
          { version: 'v1', taxonomyId: catalogId, after: null, participantId },
          () => true,
        ),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it('rejects wrong actual new-start namespace under locked source while preserving original replay', async () => {
    const command = {
      actor: subject,
      input: {
        version: 'v1',
        definitionReference: { recordId: trialId, revision: 1 },
        accommodationReference: null,
      },
      idempotencyKey: randomUUID(),
      requestId: 'namespace',
    };
    const options = {
      allowNewWrites: true,
      canStart: (s: {
        taxonomyId: string;
        participantId: string;
        skillId: string;
        skillDomain: string;
      }) => s.taxonomyId === 'foreign',
    };
    await expect(
      runCommandTransaction(db, (tx) => startPracticeTrial(tx, command, options)),
    ).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
    const saved = await runCommandTransaction(db, (tx) =>
      startPracticeTrial(tx, command, {
        ...options,
        canStart: (s: {
          taxonomyId: string;
          participantId: string;
          skillId: string;
          skillDomain: string;
        }) =>
          s.taxonomyId === catalogId &&
          s.participantId === participantId &&
          s.skillId === 'frontend' &&
          s.skillDomain === 'web',
      }),
    );
    expect(saved.status).toBe('EXECUTED');
    const replay = await runCommandTransaction(db, (tx) =>
      startPracticeTrial(tx, command, { allowNewWrites: false, canStart: () => false }),
    );
    expect(replay).toEqual({ ...saved, status: 'REPLAYED' });
  });
  it('does not accept throwing or closing new-start host policy after source waits', async () => {
    const command = {
      actor: subject,
      input: {
        version: 'v1',
        definitionReference: { recordId: trialId, revision: 1 },
        accommodationReference: null,
      },
      idempotencyKey: randomUUID(),
      requestId: 'scope',
    };
    let calls = 0;
    await expect(
      runCommandTransaction(db, (tx) =>
        startPracticeTrial(tx, command, { allowNewWrites: true, canStart: () => ++calls < 2 }),
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
    await expect(
      runCommandTransaction(db, (tx) =>
        startPracticeTrial(tx, command, {
          allowNewWrites: true,
          canStart: () => {
            throw Error('private scope');
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
    expect(await db.$queryRawUnsafe('SELECT count(*)::int AS n FROM "PracticeTrialStart"')).toEqual(
      [{ n: 1 }],
    );
  });
  it('checks current submission host scope and rolls back a closing gate; original replay survives', async () => {
    const command = {
      actor: subject,
      input: input(),
      idempotencyKey: randomUUID(),
      requestId: 'submit-scope',
    };
    await expect(
      runCommandTransaction(db, (tx) =>
        submitPracticeTrial(tx, command, { allowNewWrites: true, canSubmit: () => false }),
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
    let calls = 0;
    await expect(
      runCommandTransaction(db, (tx) =>
        submitPracticeTrial(tx, command, { allowNewWrites: true, canSubmit: () => ++calls < 2 }),
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
    expect(
      await db.$queryRawUnsafe('SELECT count(*)::int AS n FROM "PracticeTrialSubmission"'),
    ).toEqual([{ n: 0 }]);
    const saved = await runCommandTransaction(db, (tx) =>
      submitPracticeTrial(tx, command, { allowNewWrites: true, canSubmit: () => true }),
    );
    expect(
      await runCommandTransaction(db, (tx) =>
        submitPracticeTrial(tx, command, { allowNewWrites: false, canSubmit: () => false }),
      ),
    ).toEqual({ ...saved, status: 'REPLAYED' });
  });
  it('paginates more than50 actual current families without overlap or accidental truncation', async () => {
    for (let i = 0; i < 51; i++)
      await runCommandTransaction(db, (tx) =>
        publishPracticeTrialDefinition(
          tx,
          {
            actor: publisher,
            input: {
              ...definitionInput(),
              trialId: 'synthetic-page-' + String(i).padStart(3, '0'),
            },
            idempotencyKey: randomUUID(),
            requestId: 'pagination',
          },
          { allowNewWrites: true, canPublish: () => true },
        ),
      );
    const first = await browse();
    expect(first.trials).toHaveLength(50);
    expect(first.nextCursor).toBe(first.trials.at(-1)?.definition.reference.recordId);
    const second = await browse(subject, first.nextCursor);
    expect(second.trials).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.trials, ...second.trials].map((t) => t.definition.reference.recordId)).size,
    ).toBe(52);
  });
  it('never selects submission identifiers or private columns before authorizing a foreign own start', async () => {
    await submit();
    const foreign = await actor(),
      sqls: string[] = [];
    const result = await runCommandTransaction(db, (tx) =>
      readOwnPracticeTrialProgress(
        {
          ...tx,
          async query<Row>(sql: string, bindings: readonly (string | null)[]) {
            sqls.push(sql);
            return tx.query<Row>(sql, bindings);
          },
        },
        foreign,
        startId,
        () => true,
      ),
    );
    expect(result).toBeNull();
    expect(sqls.some((sql) => sql.includes('PracticeTrialSubmission'))).toBe(false);
    expect(sqls.some((sql) => sql.includes('"answer"'))).toBe(false);
  });
  it('rechecks actual own session after waiting for the original submission serialization lock', async () => {
    const locker = new PrismaClient({ transactionOptions: { timeout: 15000, maxWait: 10000 } });
    let unlock!: () => void;
    let locked!: () => void;
    const held = new Promise<void>((r) => (locked = r)),
      release = new Promise<void>((r) => (unlock = r));
    const lock = locker.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,12016))::text',
        startId,
      );
      locked();
      await release;
    });
    try {
      await held;
      await db.session.update({
        where: { tokenHash: subject.sessionHash },
        data: { expiresAt: new Date(Date.now() + 700) },
      });
      const reading = progress().then(
        (value) => ({ value, error: null }),
        (error) => ({ value: null, error }),
      );
      const deadline = Date.now() + 4000;
      let waiting = false;
      while (Date.now() < deadline) {
        const rows = await db.$queryRawUnsafe<Array<{ n: number }>>(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory'",
        );
        if (rows[0].n) {
          waiting = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(waiting).toBe(true);
      await db.$queryRawUnsafe('SELECT pg_sleep(0.8)::text');
      unlock();
      await lock;
      const result = await reading;
      expect(result.error).toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
      expect(result.value).toBeNull();
    } finally {
      unlock();
      await lock;
      await locker.$disconnect();
    }
  });
});
