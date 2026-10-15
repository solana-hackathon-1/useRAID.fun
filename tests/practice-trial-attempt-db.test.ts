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
  readPracticeTrialStart,
  PracticeTrialAttemptStorageError,
} from '../src/skills/practice-trial-attempt-storage';
import { definition as fixture } from '../examples/skill-assessments/fixtures';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const catalogId = 'synthetic-start-catalog',
  trialId = 'synthetic-start-trial';
let publisher: SkillTaxonomyActor, subject: SkillTaxonomyActor, participantId: string;
const skills = [
  { id: 'frontend', domain: 'web', name: 'Frontend', status: 'ACTIVE', aliases: ['frontend'] },
];
async function actor(admin = false, mapped = true, via = 'wallet') {
  const user = await db.user.create({
    data: {
      handle: 'synthetic',
      role: admin ? 'ADMIN' : 'CREATOR',
      xId: admin ? randomUUID() : null,
    },
  });
  const sessionHash = hash(randomUUID());
  await db.session.create({
    data: { tokenHash: sessionHash, userId: user.id, via, expiresAt: new Date(Date.now() + 60000) },
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
function publication(
  expectedRevision = 0,
  patch: Record<string, unknown> = {},
  availability = 'AVAILABLE',
  taxonomyRevision = 1,
) {
  const draft = structuredClone(fixture);
  for (const key of ['reference', 'publishedAt', 'state']) Reflect.deleteProperty(draft, key);
  return {
    trialId,
    expectedRevision,
    taxonomyReference: { recordId: catalogId, revision: taxonomyRevision },
    availability,
    draft: {
      ...draft,
      rubric: { ...draft.rubric, reference: { recordId: 'synthetic-start-rubric', revision: 1 } },
      maximumAttempts: 3,
      cooldownSeconds: 0,
      ...patch,
    },
  };
}
const publish = (body: unknown = publication()) =>
  runCommandTransaction(db, (tx) =>
    publishPracticeTrialDefinition(
      tx,
      {
        actor: publisher,
        input: body,
        idempotencyKey: randomUUID(),
        requestId: 'synthetic-definition',
      },
      { allowNewWrites: true, canPublish: () => true },
    ),
  );
const catalog = (revision = 0, entries: unknown = skills) =>
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
const input = (revision = 1) => ({
  version: 'v1',
  definitionReference: { recordId: trialId, revision },
  accommodationReference: null,
});
const start = (a = subject, body: unknown = input(), key = randomUUID(), enabled = true) =>
  runCommandTransaction(db, (tx) =>
    startPracticeTrial(
      tx,
      { actor: a, input: body, idempotencyKey: key, requestId: 'synthetic-start' },
      { allowNewWrites: enabled },
    ),
  );
const read = (id: string, a = subject) =>
  runCommandTransaction(db, (tx) => readPracticeTrialStart(tx, a, id));
const counts = () =>
  db.$queryRawUnsafe(
    `SELECT (SELECT count(*)::int FROM "PracticeTrialStart") starts,(SELECT count(*)::int FROM "CommandReceipt") receipts,(SELECT count(*)::int FROM "AuditEvent") audits,(SELECT count(*)::int FROM "OutboxEvent") outbox,(SELECT count(*)::int FROM "Participant") participants`,
  );
integration('T013C2 durable canonical private practice starts', () => {
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
    publisher = await actor(true, false, 'x');
    subject = await actor();
    const row = await db.participant.findUnique({ where: { accountId: subject.accountId } });
    if (!row) throw Error('Synthetic mapping absent');
    participantId = row.id;
    await catalog();
    await publish();
  });
  afterAll(() => Promise.all([db.$disconnect(), locker?.$disconnect(), observer?.$disconnect()]));
  it('persists an immutable current canonical start with exact original definition/rubric/tool consent and no rank/grant/capacity/money', async () => {
    const value = await start();
    expect(value.status).toBe('EXECUTED');
    expect(value.start).toMatchObject({
      version: 'v1',
      state: 'STARTED',
      participantId,
      attemptNumber: 1,
      definition: {
        reference: input().definitionReference,
        targetRank: 'A',
        rubric: { reference: { recordId: 'synthetic-start-rubric', revision: 1 } },
      },
      taxonomyReference: { recordId: catalogId, revision: 1 },
      accommodationReference: null,
      persisted: true,
      verifiesSkill: false,
      isAuthorizationToken: false,
      createsPermissionGrant: false,
      consumesCapacity: false,
      createsFinancialObligation: false,
    });
    expect(Object.isFrozen(value.start)).toBe(true);
    expect(Object.isFrozen(value.start.definition.tools)).toBe(true);
    expect(await read(value.start.id)).toEqual(value.start);
    expect(await counts()).toEqual([
      { starts: 1, receipts: 3, audits: 3, outbox: 0, participants: 1 },
    ]);
  });
  it('requires an actual existing HUMAN without autoprovision', async () => {
    const missing = await actor(false, false);
    const before = await db.participant.count();
    await expect(start(missing)).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
    expect(await db.participant.count()).toBe(before);
  });
  it.each([
    'participantId',
    'attemptHistory',
    'attemptNumber',
    'startedAt',
    'persisted',
    'assessedRank',
  ])('rejects forged %s before any effect', async (field) => {
    await expect(start(subject, { ...input(), [field]: 'forged' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
  it('supports current own X and wallet sessions without admin or token purchase', async () => {
    const first = await start();
    await db.session.update({ where: { tokenHash: subject.sessionHash }, data: { via: 'x' } });
    const next = await start();
    expect(first.start.participantId).toBe(next.start.participantId);
    expect(next.start.attemptNumber).toBe(2);
  });
  it('keeps foreign and missing private starts undisclosed', async () => {
    const saved = await start(),
      other = await actor();
    expect(await read(saved.start.id, other)).toBeNull();
    expect(await read(randomUUID())).toBeNull();
  });
  it.each(['expired', 'revoked', 'foreign', 'unsupported'])(
    'rejects a %s session with total rollback',
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
      await expect(start()).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
      expect(await counts()).toEqual(before);
    },
  );
  it('denies suspension on new commands, replay and private reads', async () => {
    const key = randomUUID(),
      saved = await start(subject, input(), key),
      before = await counts();
    await db.user.update({ where: { id: subject.accountId }, data: { suspended: true } });
    await expect(start()).rejects.toMatchObject({ code: 'ACCOUNT_RESTRICTED' });
    await expect(start(subject, input(), key)).rejects.toMatchObject({
      code: 'ACCOUNT_RESTRICTED',
    });
    await expect(read(saved.start.id)).rejects.toMatchObject({ code: 'ACCOUNT_RESTRICTED' });
    expect(await counts()).toEqual(before);
  });
  it('retains the exact original receipt and private history after retirement and writes disabled', async () => {
    const key = randomUUID(),
      first = await start(subject, input(), key);
    await publish(publication(1, { title: 'Retired synthetic definition' }, 'RETIRED'));
    const before = await counts(),
      replay = await start(subject, input(), key, false);
    expect(replay).toEqual({ status: 'REPLAYED', start: first.start });
    expect(await read(first.start.id)).toEqual(first.start);
    await expect(start(subject, input(2))).rejects.toMatchObject({
      code: 'DEFINITION_UNAVAILABLE',
    });
    expect(await counts()).toEqual(before);
  });
  it('disables only new intent and rejects changed idempotent bodies after current authorization', async () => {
    const key = randomUUID(),
      first = await start(subject, input(), key),
      before = await counts();
    await expect(start(subject, input(), randomUUID(), false)).rejects.toMatchObject({
      code: 'WRITES_DISABLED',
    });
    expect((await start(subject, input(), key, false)).start).toEqual(first.start);
    await expect(start(subject, input(2), key)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    await db.session.delete({ where: { tokenHash: subject.sessionHash } });
    await expect(start(subject, input(2), key)).rejects.toMatchObject({
      code: 'AUTHENTICATION_REQUIRED',
    });
    expect(await counts()).toEqual(before);
  });
  it('requires the actual current definition and current active skill', async () => {
    await expect(start(subject, input(2))).rejects.toMatchObject({ code: 'REVISION_CHANGED' });
    await start();
    await catalog(1, [{ ...skills[0], status: 'RETIRED' }]);
    const before = await counts();
    await expect(start()).rejects.toMatchObject({ code: 'SKILL_UNAVAILABLE' });
    expect(await counts()).toEqual(before);
  });
  it('rejects accommodations until real scoped approved records exist, without consuming attempts', async () => {
    const before = await counts();
    await expect(
      start(subject, {
        ...input(),
        accommodationReference: { recordId: 'synthetic-accommodation', revision: 1 },
      }),
    ).rejects.toMatchObject({ code: 'ACCOMMODATION_UNAVAILABLE' });
    expect(await counts()).toEqual(before);
  });
  it('counts every family start across revisions and enforces the current published maximum', async () => {
    await start();
    await start();
    await publish(publication(1, { maximumAttempts: 2 }));
    const before = await counts();
    await expect(start(subject, input(2))).rejects.toMatchObject({ code: 'ATTEMPT_LIMIT_REACHED' });
    expect(await counts()).toEqual(before);
  });
  it('uses family-wide last actual start for current published cooldown without rewriting history', async () => {
    const original = await start();
    await publish(publication(1, { cooldownSeconds: 60 }));
    await expect(start(subject, input(2))).rejects.toMatchObject({ code: 'COOLDOWN_ACTIVE' });
    await publish(publication(2, { cooldownSeconds: 0 }));
    expect((await start(subject, input(3))).start.attemptNumber).toBe(2);
    expect(await read(original.start.id)).toEqual(original.start);
  });
  it('serializes concurrent duplicate intent into one original start', async () => {
    const key = randomUUID(),
      values = await Promise.all([start(subject, input(), key), start(subject, input(), key)]);
    expect(values.map((v) => v.status).sort()).toEqual(['EXECUTED', 'REPLAYED']);
    expect(values[0].start).toEqual(values[1].start);
    expect(await counts()).toEqual([
      { starts: 1, receipts: 3, audits: 3, outbox: 0, participants: 1 },
    ]);
  });
  it('enforces a one-attempt definition across concurrent linked own sessions', async () => {
    await publish(publication(1, { maximumAttempts: 1 }));
    const alternate = { ...subject, sessionHash: hash(randomUUID()) };
    await db.session.create({
      data: {
        tokenHash: alternate.sessionHash,
        userId: subject.accountId,
        via: 'x',
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    const values = await Promise.allSettled([start(subject, input(2)), start(alternate, input(2))]);
    expect(values.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
    for (const value of values)
      if (value.status === 'rejected')
        expect(value.reason).toMatchObject({ code: 'ATTEMPT_LIMIT_REACHED' });
  });
  it('keeps family histories separate for different canonical participants', async () => {
    const other = await actor(),
      [a, b] = await Promise.all([start(), start(other)]);
    expect(a.start.attemptNumber).toBe(1);
    expect(b.start.attemptNumber).toBe(1);
    expect(a.start.participantId).not.toBe(b.start.participantId);
  });
  it('rejects unknown definitions and malformed private read identifiers', async () => {
    await expect(
      start(subject, { ...input(), definitionReference: { recordId: 'absent', revision: 1 } }),
    ).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
    await expect(read('bad identifier')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it('observes actual session expiry while blocked on family history', async () => {
    let release!: () => void, acquired!: () => void;
    const ready = new Promise<void>((r) => {
        acquired = r;
      }),
      held = new Promise<void>((r) => {
        release = r;
      });
    const lock = locker.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtextextended($1,12015))::text`,
        participantId + ':' + trialId,
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
      work = expect(start()).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
      // Observe immediately; awaiting the original below still asserts every failure.
      void work.catch(() => {});
      const deadline = Date.now() + 2000;
      let blocked = false;
      while (Date.now() < deadline) {
        const rows = await observer.$queryRawUnsafe<{ waiting: boolean }[]>(
          `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0) AS waiting`,
        );
        if (rows[0].waiting) {
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
      { starts: 0, receipts: 2, audits: 2, outbox: 0, participants: 1 },
    ]);
  });
  type Probe = {
    number?: number;
    participant?: string;
    account?: string;
    definition?: string;
    taxonomy?: string;
    startedAt?: string;
    receiptActor?: string;
    kind?: string;
    request?: string;
    auditAggregate?: string;
    publish?: boolean;
    payload?: Record<string, string>;
    omitAudit?: boolean;
  };
  async function direct(patch: Probe = {}) {
    return db.$transaction(async (raw) => {
      const port = createPrismaCommandTransaction(raw);
      return executeIdempotentCommand(
        port,
        {
          actorId: patch.receiptActor ?? subject.accountId,
          commandKind: patch.kind ?? 'StartPracticeTrial',
          idempotencyKey: randomUUID(),
          requestId: 'synthetic-raw-start',
          request: { synthetic: true },
        },
        async ({ receiptId }) => {
          const [refs] = await raw.$queryRawUnsafe<
            { definition: string; taxonomy: string; revision: number }[]
          >(
            `SELECT p."currentVersionId"::text AS definition,t."currentVersionId"::text AS taxonomy,t."revision" FROM "PracticeTrial" p JOIN "SkillTaxonomy" t ON t."id"=p."taxonomyId" WHERE p."id"=$1`,
            trialId,
          );
          const [sequence] = await raw.$queryRawUnsafe<{ number: number }[]>(
            `SELECT count(*)::int+1 AS number FROM "PracticeTrialStart" WHERE "participantId"=$1::uuid AND "trialId"=$2`,
            participantId,
            trialId,
          );
          const [clock] = await raw.$queryRawUnsafe<{ now: Date }[]>(
            `SELECT date_trunc('milliseconds',clock_timestamp()) AS now`,
          );
          const id = randomUUID();
          await raw.$executeRawUnsafe(
            `INSERT INTO "PracticeTrialStart"("id","participantId","accountId","trialId","definitionVersionId","taxonomyId","taxonomyRevision","taxonomyVersionId","attemptNumber","startedAt","receiptId","requestId") VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,$6,$7::int,$8::uuid,$9::int,$10::timestamptz,$11::uuid,$12)`,
            id,
            patch.participant ?? participantId,
            patch.account ?? subject.accountId,
            trialId,
            patch.definition ?? refs.definition,
            catalogId,
            refs.revision,
            patch.taxonomy ?? refs.taxonomy,
            patch.number ?? sequence.number,
            patch.startedAt ?? clock.now.toISOString(),
            receiptId,
            patch.request ?? 'synthetic-raw-start',
          );
          return {
            resultRef: id,
            events: patch.omitAudit
              ? []
              : [
                  {
                    type: 'skill.practice_trial_started.v1',
                    aggregateId: patch.auditAggregate ?? id,
                    aggregateVersion: 1,
                    payload: patch.payload ?? { practiceTrialStartId: id },
                    publish: patch.publish ?? false,
                  },
                ],
          };
        },
      );
    });
  }
  it('has a valid privileged SQL control with matching immutable identity, versions, receipt and private audit', async () => {
    const saved = await direct();
    expect(saved.status).toBe('EXECUTED');
    expect(await read(saved.resultRef)).toMatchObject({
      participantId,
      attemptNumber: 1,
      definition: { reference: input().definitionReference },
    });
  });
  it.each([
    ['sequence gap', { number: 2 }],
    ['zero attempt', { number: 0 }],
    ['foreign account mapping', { account: 'absent' }],
    ['foreign participant', { participant: randomUUID() }],
    ['foreign definition', { definition: randomUUID() }],
    ['future time', { startedAt: '2099-01-01T00:00:00Z' }],
    ['backdated time', { startedAt: '2020-01-01T00:00:00Z' }],
    ['wrong command', { kind: 'SaveSkillClaim' }],
    ['wrong receipt actor', { receiptActor: 'absent' }],
    ['wrong request', { request: 'other-request' }],
    ['wrong aggregate', { auditAggregate: randomUUID() }],
    ['public outbox', { publish: true }],
    ['extra payload', { payload: { practiceTrialStartId: 'wrong', answer: 'private' } }],
    ['missing audit', { omitAudit: true }],
  ] satisfies [string, Probe][])(
    'rejects privileged SQL %s with total rollback',
    async (_name, patch) => {
      const before = await counts();
      await expect(direct(patch)).rejects.toBeDefined();
      expect(await counts()).toEqual(before);
    },
  );
  it('rejects privileged SQL bypass of actual published family limit and cooldown', async () => {
    await start();
    await publish(publication(1, { cooldownSeconds: 60 }));
    let before = await counts();
    await expect(direct()).rejects.toBeDefined();
    expect(await counts()).toEqual(before);
    await publish(publication(2, { maximumAttempts: 1 }));
    before = await counts();
    await expect(direct()).rejects.toBeDefined();
    expect(await counts()).toEqual(before);
  });
  it('rejects privileged SQL stale, retired and inactive references', async () => {
    const [old] = await db.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id"::text FROM "PracticeTrialVersion" WHERE "trialId"=$1`,
      trialId,
    );
    await publish(publication(1));
    let before = await counts();
    await expect(direct({ definition: old.id })).rejects.toBeDefined();
    expect(await counts()).toEqual(before);
    await publish(publication(2, {}, 'RETIRED'));
    before = await counts();
    await expect(direct()).rejects.toBeDefined();
    expect(await counts()).toEqual(before);
    await publish(publication(3));
    await catalog(1, [{ ...skills[0], status: 'RETIRED' }]);
    before = await counts();
    await expect(direct()).rejects.toBeDefined();
    expect(await counts()).toEqual(before);
  });
  it.each([
    'UPDATE "PracticeTrialStart" SET "attemptNumber"=2 WHERE "id"=$1::uuid',
    'UPDATE "PracticeTrialStart" SET "id"="id" WHERE "id"=$1::uuid',
    'DELETE FROM "PracticeTrialStart" WHERE "id"=$1::uuid',
  ])('keeps saved start history immutable: %s', async (sql) => {
    const saved = await start(),
      before = await counts();
    await expect(db.$executeRawUnsafe(sql, saved.start.id)).rejects.toBeDefined();
    expect(await counts()).toEqual(before);
    expect(await read(saved.start.id)).toEqual(saved.start);
  });
  async function waitForBlocked() {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const [row] = await observer.$queryRawUnsafe<{ waiting: boolean }[]>(
        `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0) AS waiting`,
      );
      if (row.waiting) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw Error('Expected real PostgreSQL lock wait was not observed');
  }
  it.each(['suspend', 'revoke'])(
    'observes actual %s committed before User/session locks',
    async (change) => {
      let acquired!: () => void, release!: () => void;
      const ready = new Promise<void>((r) => {
          acquired = r;
        }),
        held = new Promise<void>((r) => {
          release = r;
        });
      const lock = locker.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          `SELECT "id" FROM "User" WHERE "id"=$1 FOR NO KEY UPDATE`,
          subject.accountId,
        );
        acquired();
        await held;
        if (change === 'suspend')
          await tx.user.update({ where: { id: subject.accountId }, data: { suspended: true } });
        else await tx.session.delete({ where: { tokenHash: subject.sessionHash } });
      });
      await ready;
      const work = expect(start()).rejects.toMatchObject({
        code: change === 'suspend' ? 'ACCOUNT_RESTRICTED' : 'AUTHENTICATION_REQUIRED',
      });
      void work.catch(() => {});
      try {
        await waitForBlocked();
      } finally {
        release();
        await lock;
        await work;
      }
      expect(await counts()).toEqual([
        { starts: 0, receipts: 2, audits: 2, outbox: 0, participants: 1 },
      ]);
    },
  );

  it('starts against a refreshed active catalog while retaining the original approved definition', async () => {
    await catalog(1, [{ ...skills[0], name: 'Frontend refreshed' }]);
    const key = randomUUID(),
      saved = await start(subject, input(), key);
    expect(saved.start.taxonomyReference).toEqual({ recordId: catalogId, revision: 2 });
    expect(saved.start.definition.reference).toEqual(input().definitionReference);
    await catalog(2, [{ ...skills[0], name: 'Frontend refreshed', status: 'RETIRED' }]);
    expect((await start(subject, input(), key, false)).start).toEqual(saved.start);
  });
  it('rejects restricted privileged SQL with complete receipt and start rollback', async () => {
    await db.user.update({ where: { id: subject.accountId }, data: { suspended: true } });
    const before = await counts();
    await expect(direct()).rejects.toBeDefined();
    expect(await counts()).toEqual(before);
  });

  it('normalizes a current session denial from the saved definition reader to its owned typed error', async () => {
    await db.session.update({
      where: { tokenHash: subject.sessionHash },
      data: { expiresAt: new Date(Date.now() + 400) },
    });
    let observedDefinitionRead = false;
    const work = runCommandTransaction(db, (port) =>
      startPracticeTrial(
        {
          ...port,
          async query<Row>(sql: string, bindings: readonly (string | null)[]) {
            if (sql.startsWith('SELECT "definition","availability"')) {
              observedDefinitionRead = true;
              await port.query('SELECT pg_sleep(0.5)::text', []);
            }
            return port.query<Row>(sql, bindings);
          },
        },
        {
          actor: subject,
          input: input(),
          idempotencyKey: randomUUID(),
          requestId: 'synthetic-reader-expiry',
        },
        { allowNewWrites: true },
      ),
    );
    await expect(work).rejects.toBeInstanceOf(PracticeTrialAttemptStorageError);
    await expect(work).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
    expect(observedDefinitionRead).toBe(true);
    expect(await counts()).toEqual([
      { starts: 0, receipts: 2, audits: 2, outbox: 0, participants: 1 },
    ]);
  });
});
