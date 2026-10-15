import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { type z } from 'zod';
import { PracticeTrialDefinitionSchema } from '../src/skills/practice-trial-contracts';
import { PrismaClient, type Prisma } from '@prisma/client';
import { db } from '../src/lib/db';
import { hash } from '../src/lib/auth-primitives';
import {
  runCommandTransaction,
  createPrismaCommandTransaction,
} from '../src/lib/command-receipts-adapter';
import { executeIdempotentCommand } from '../src/command-receipts';
import { publishSkillTaxonomy, type SkillTaxonomyActor } from '../src/skills/taxonomy-storage';
import {
  publishPracticeTrialDefinition,
  readPracticeTrialDefinition,
} from '../src/skills/practice-trial-storage';
import { definition as syntheticDefinition } from '../examples/skill-assessments/fixtures';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const catalogId = 'synthetic-practice-catalog',
  trialId = 'synthetic-practice-trial';
const skills = [
  { id: 'frontend', domain: 'web', name: 'Frontend', status: 'ACTIVE', aliases: ['frontend'] },
];
let allowed = new Set<string>(),
  publisher: SkillTaxonomyActor;
async function actor(admin = true) {
  const xId = 'synthetic-' + randomUUID();
  const user = await db.user.create({
    data: { handle: 'synthetic', role: admin ? 'ADMIN' : 'CREATOR', xId },
  });
  allowed.add(xId);
  const sessionHash = hash(randomUUID());
  await db.session.create({
    data: {
      tokenHash: sessionHash,
      userId: user.id,
      via: 'x',
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  return { accountId: user.id, sessionHash };
}
function input(expectedRevision = 0) {
  const draft = structuredClone(syntheticDefinition);
  for (const key of ['reference', 'publishedAt', 'state']) Reflect.deleteProperty(draft, key);
  return {
    trialId,
    expectedRevision,
    taxonomyReference: { recordId: catalogId, revision: 1 },
    availability: 'AVAILABLE',
    draft: {
      ...draft,
      rubric: { ...draft.rubric, reference: { recordId: 'synthetic-rubric', revision: 1 } },
    },
  };
}
const options = (allowNewWrites = true) => ({
  allowNewWrites,
  canPublish: (user: Readonly<{ accountId: string; xId: string }>) => allowed.has(user.xId),
});
const save = (
  a: SkillTaxonomyActor = publisher,
  body: unknown = input(),
  key = randomUUID(),
  enabled = true,
) =>
  runCommandTransaction(db, (tx) =>
    publishPracticeTrialDefinition(
      tx,
      { actor: a, input: body, idempotencyKey: key, requestId: 'synthetic-request' },
      options(enabled),
    ),
  );
const read = (a: SkillTaxonomyActor = publisher, id = trialId, revision?: number) =>
  runCommandTransaction(db, (tx) => readPracticeTrialDefinition(tx, a, id, revision));
const catalog = (a: SkillTaxonomyActor = publisher, revision = 0, entries: unknown = skills) =>
  runCommandTransaction(db, (tx) =>
    publishSkillTaxonomy(
      tx,
      {
        actor: a,
        input: { taxonomyId: catalogId, expectedRevision: revision, skills: entries },
        idempotencyKey: randomUUID(),
        requestId: 'catalog-seed',
      },
      options(),
    ),
  );
const counts = () =>
  db.$queryRawUnsafe(
    `SELECT (SELECT count(*)::int FROM "PracticeTrialVersion") versions,(SELECT count(*)::int FROM "SkillRubricVersion") rubrics,(SELECT count(*)::int FROM "CommandReceipt") receipts,(SELECT count(*)::int FROM "AuditEvent") audits,(SELECT count(*)::int FROM "OutboxEvent") outbox`,
  );
integration('T013C1 durable approved practice definitions', () => {
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
    allowed = new Set();
    publisher = await actor();
    await catalog();
  });
  afterAll(() => Promise.all([db.$disconnect(), locker?.$disconnect(), observer?.$disconnect()]));
  type Probe = {
    mutate?: (value: z.output<typeof PracticeTrialDefinitionSchema>) => unknown;
    revision?: number;
    omitProjection?: boolean;
    kind?: string;
    auditActor?: string;
    payload?: Record<string, string>;
    publish?: boolean;
  };
  const direct = (patch: Probe = {}) =>
    db.$transaction(async (tx) =>
      executeIdempotentCommand(
        createPrismaCommandTransaction(tx),
        {
          actorId: publisher.accountId,
          commandKind: patch.kind ?? 'PublishPracticeTrial',
          idempotencyKey: randomUUID(),
          requestId: 'sql-probe',
          request: {},
        },
        async ({ receiptId }) => {
          const [old] = await tx.$queryRawUnsafe<
            {
              definition: unknown;
              taxonomyId: string;
              taxonomyRevision: number;
              taxonomyVersionId: string;
              rubricId: string;
              rubricRevision: number;
              rubricVersionId: string;
              now: Date;
            }[]
          >(
            'SELECT *,date_trunc(\'milliseconds\',clock_timestamp()) AS now FROM "PracticeTrialVersion" WHERE "trialId"=$1 ORDER BY "revision" DESC LIMIT 1',
            trialId,
          );
          const previous = PracticeTrialDefinitionSchema.parse(old.definition),
            revision = patch.revision ?? previous.reference.revision + 1;
          const candidate = {
            ...previous,
            reference: { recordId: trialId, revision },
            publishedAt: old.now.toISOString(),
          };
          const definition = patch.mutate ? patch.mutate(candidate) : candidate;
          const [row] = await tx.$queryRawUnsafe<{ id: string }[]>(
            'INSERT INTO "PracticeTrialVersion"("trialId","revision","skillId","skillDomain","taxonomyId","taxonomyRevision","taxonomyVersionId","rubricId","rubricRevision","rubricVersionId","definition","availability","receiptId","publishedByAccountId","requestId","publishedAt") VALUES($1,$2::int,$3,$4,$5,$6::int,$7::uuid,$8,$9::int,$10::uuid,$11::jsonb,\'AVAILABLE\',$12::uuid,$13,\'sql-probe\',$14::timestamptz) RETURNING "id"::text',
            trialId,
            revision,
            previous.skillId,
            previous.skillDomain,
            old.taxonomyId,
            old.taxonomyRevision,
            old.taxonomyVersionId,
            old.rubricId,
            old.rubricRevision,
            old.rubricVersionId,
            JSON.stringify(definition),
            receiptId,
            patch.auditActor ?? publisher.accountId,
            old.now.toISOString(),
          );
          if (!patch.omitProjection)
            await tx.$executeRawUnsafe(
              'UPDATE "PracticeTrial" SET "revision"=$2::int,"currentVersionId"=$3::uuid WHERE "id"=$1',
              trialId,
              revision,
              row.id,
            );
          return {
            resultRef: row.id,
            events: [
              {
                type: 'skill.practice_trial_published.v1',
                aggregateId: trialId,
                aggregateVersion: revision,
                payload: patch.payload ?? { practiceTrialVersionId: row.id },
                publish: patch.publish ?? false,
              },
            ],
          };
        },
      ),
    );
  it('direct SQL control commits a valid next immutable version with matching private receipt/audit', async () => {
    await save();
    await direct();
    expect((await read())?.definition.reference.revision).toBe(2);
  });
  it.each(['version', 'state', 'purpose', 'targetRank', 'evaluatorMethod'] as const)(
    'direct SQL rejects nullable required literal %s',
    async (field) => {
      await save();
      const before = await counts();
      await expect(direct({ mutate: (value) => ({ ...value, [field]: null }) })).rejects.toThrow();
      expect(await counts()).toEqual(before);
    },
  );
  it.each(['material', 'aiAssistance'] as const)(
    'direct SQL rejects nullable nested %s',
    async (field) => {
      await save();
      const before = await counts();
      await expect(
        direct({
          mutate: (value) =>
            field === 'material'
              ? { ...value, inputs: [{ ...value.inputs[0], material: null }] }
              : { ...value, tools: { ...value.tools, aiAssistance: null } },
        }),
      ).rejects.toThrow();
      expect(await counts()).toEqual(before);
    },
  );
  it.each([
    'shape',
    'domain',
    'rubric',
    'revision',
    'projection',
    'kind',
    'actor',
    'payload',
    'outbox',
    'trim',
    'utf16',
  ] as const)(
    'direct SQL rejects %s violations and rolls back prepared receipt/audit',
    async (kind) => {
      await save();
      const before = await counts(),
        patch: Probe = {};
      if (kind === 'shape') patch.mutate = (value) => ({ ...value, hiddenAnswers: 'private' });
      if (kind === 'domain') patch.mutate = (value) => ({ ...value, skillDomain: 'other' });
      if (kind === 'rubric')
        patch.mutate = (value) => ({
          ...value,
          rubric: {
            ...value.rubric,
            criteria: [
              { ...value.rubric.criteria[0], description: 'Changed under existing reference' },
            ],
          },
        });
      if (kind === 'revision') patch.revision = 3;
      if (kind === 'projection') patch.omitProjection = true;
      if (kind === 'kind') patch.kind = 'WrongPracticeCommand';
      if (kind === 'actor') patch.auditActor = (await actor()).accountId;
      if (kind === 'payload') patch.payload = { operationId: 'wrong' };
      if (kind === 'outbox') patch.publish = true;
      if (kind === 'trim') patch.mutate = (value) => ({ ...value, title: '\u00a0Untrimmed' });
      if (kind === 'utf16') patch.mutate = (value) => ({ ...value, title: '😀'.repeat(101) });
      await expect(direct(patch)).rejects.toThrow();
      expect(await counts()).toEqual(before);
    },
  );
  it.each([
    'version-update',
    'version-delete',
    'rubric-update',
    'rubric-delete',
    'family-change',
    'family-delete',
  ] as const)('database preserves immutable %s records', async (kind) => {
    await save();
    const before = await counts();
    const sql =
      kind === 'version-update'
        ? 'UPDATE "PracticeTrialVersion" SET "availability"=\'RETIRED\''
        : kind === 'version-delete'
          ? 'DELETE FROM "PracticeTrialVersion"'
          : kind === 'rubric-update'
            ? 'UPDATE "SkillRubricVersion" SET "criteria"="criteria"'
            : kind === 'rubric-delete'
              ? 'DELETE FROM "SkillRubricVersion"'
              : kind === 'family-change'
                ? 'UPDATE "PracticeTrial" SET "skillDomain"=\'other\''
                : 'DELETE FROM "PracticeTrial"';
    await expect(db.$executeRawUnsafe(sql)).rejects.toThrow();
    expect(await counts()).toEqual(before);
  });
  it('serializes two different trial IDs competing for one new immutable rubric version', async () => {
    const other = await actor(),
      first = input(),
      second = {
        ...input(),
        trialId: 'other-trial',
        draft: {
          ...input().draft,
          rubric: {
            ...input().draft.rubric,
            criteria: [
              { ...input().draft.rubric.criteria[0], description: 'Different approved criteria' },
            ],
          },
        },
      };
    const results = await Promise.allSettled([save(publisher, first), save(other, second)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'RUBRIC_CONFLICT' },
    });
    expect(await counts()).toEqual([
      { versions: 1, rubrics: 1, receipts: 2, audits: 2, outbox: 0 },
    ]);
  });
  it('persists actual actor-attributed definition/rubric/current pointer with one private audit and no outbox', async () => {
    const result = await save();
    expect(result.status).toBe('EXECUTED');
    expect(result.trial).toMatchObject({
      version: 'v1',
      availability: 'AVAILABLE',
      publishedByAccountId: publisher.accountId,
      taxonomyReference: { recordId: catalogId, revision: 1 },
      persisted: true,
      verifiesSkill: false,
      createsPermissionGrant: false,
      consumesCapacity: false,
      createsFinancialObligation: false,
    });
    expect(result.trial.definition).toMatchObject({
      ...input().draft,
      reference: { recordId: trialId, revision: 1 },
      state: 'PUBLISHED',
    });
    expect(Number.isNaN(Date.parse(result.trial.definition.publishedAt))).toBe(false);
    expect(Object.isFrozen(result.trial.definition.rubric.criteria)).toBe(true);
    expect(await counts()).toEqual([
      { versions: 1, rubrics: 1, receipts: 2, audits: 2, outbox: 0 },
    ]);
    expect(await read()).toEqual(result.trial);
  });
  it('reads absent/current/historical records with current own ordinary wallet authority', async () => {
    const ordinary = await actor(false);
    expect(await read(ordinary)).toBeNull();
    const first = await save();
    await db.session.update({
      where: { tokenHash: ordinary.sessionHash },
      data: { via: 'wallet' },
    });
    expect(await read(ordinary)).toEqual(first.trial);
    expect(await read(ordinary, trialId, 1)).toEqual(first.trial);
    expect(await read(ordinary, trialId, 2)).toBeNull();
  });
  it('retains original receipt/body after later publication, retirement and disabled new writes', async () => {
    const body = input(),
      key = randomUUID(),
      first = await save(publisher, body, key);
    const next = {
      ...input(1),
      availability: 'RETIRED',
      draft: { ...input().draft, title: 'Retired synthetic exercise' },
    };
    const second = await save(publisher, next);
    expect(second.trial.definition.reference.revision).toBe(2);
    expect(second.trial.availability).toBe('RETIRED');
    expect(await save(publisher, body, key, false)).toEqual({
      status: 'REPLAYED',
      trial: first.trial,
    });
    expect(await read(publisher, trialId, 1)).toEqual(first.trial);
    expect(await read()).toEqual(second.trial);
    expect(await counts()).toEqual([
      { versions: 2, rubrics: 1, receipts: 3, audits: 3, outbox: 0 },
    ]);
  });
  it.each(['role', 'xId', 'allowlist', 'suspended', 'wallet'] as const)(
    'denies current %s removal for new publication and original replay',
    async (kind) => {
      const key = randomUUID();
      await save(publisher, input(), key);
      if (kind === 'allowlist') allowed.clear();
      else if (kind === 'wallet')
        await db.session.update({
          where: { tokenHash: publisher.sessionHash },
          data: { via: 'wallet' },
        });
      else
        await db.user.update({
          where: { id: publisher.accountId },
          data:
            kind === 'role'
              ? { role: 'CREATOR' }
              : kind === 'xId'
                ? { xId: null }
                : { suspended: true },
        });
      const code = kind === 'suspended' ? 'ACCOUNT_RESTRICTED' : 'FORBIDDEN';
      await Promise.all(
        [save(publisher, input(), key, false), save(publisher, input(1))].map((work) =>
          expect(work).rejects.toMatchObject({ code }),
        ),
      );
      expect(await counts()).toEqual([
        { versions: 1, rubrics: 1, receipts: 2, audits: 2, outbox: 0 },
      ]);
    },
  );
  it.each(['foreign', 'expired', 'revoked', 'invalid-via'] as const)(
    'denies %s session on new/replay/read',
    async (kind) => {
      const key = randomUUID();
      await save(publisher, input(), key);
      if (kind === 'foreign')
        publisher = { ...publisher, sessionHash: (await actor()).sessionHash };
      else if (kind === 'revoked')
        await db.session.delete({ where: { tokenHash: publisher.sessionHash } });
      else
        await db.session.update({
          where: { tokenHash: publisher.sessionHash },
          data: kind === 'expired' ? { expiresAt: new Date(0) } : { via: 'forged' },
        });
      await Promise.all(
        [save(publisher, input(), key), save(publisher, input(1)), read()].map((work) =>
          expect(work).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' }),
        ),
      );
    },
  );
  it('rejects body forgery/unsupported material/encoding before prepared effects', async () => {
    for (const extra of [
      { publishedByAccountId: 'forged' },
      { publishedAt: '2026-10-15T00:00:00Z' },
      { isAdmin: true },
      { state: 'VERIFIED' },
    ])
      await expect(save(publisher, { ...input(), ...extra })).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    for (const draft of [
      { ...input().draft, purpose: 'CUSTOMER_PRODUCTION' },
      { ...input().draft, hiddenAnswers: 'private' },
      { ...input().draft, brief: 'bad\u0000data' },
      { ...input().draft, brief: 'bad\ud800data' },
    ])
      await expect(save(publisher, { ...input(), draft })).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    expect(await counts()).toEqual([
      { versions: 0, rubrics: 0, receipts: 1, audits: 1, outbox: 0 },
    ]);
  });
  it('enforces current catalog/version/domain/active status and stable trial family', async () => {
    await expect(
      save(publisher, { ...input(), taxonomyReference: { recordId: catalogId, revision: 2 } }),
    ).rejects.toMatchObject({ code: 'REVISION_CHANGED' });
    await expect(
      save(publisher, { ...input(), draft: { ...input().draft, skillDomain: 'other' } }),
    ).rejects.toMatchObject({ code: 'SKILL_UNAVAILABLE' });
    await save();
    await catalog(publisher, 1, [{ ...skills[0], status: 'RETIRED' }]);
    await expect(save(publisher, input(1))).rejects.toMatchObject({ code: 'REVISION_CHANGED' });
    const current = { ...input(1), taxonomyReference: { recordId: catalogId, revision: 2 } };
    await expect(save(publisher, current)).rejects.toMatchObject({ code: 'SKILL_UNAVAILABLE' });
    const retired = await save(publisher, { ...current, availability: 'RETIRED' });
    expect(retired.trial.availability).toBe('RETIRED');
    expect((await read(publisher, trialId, 1))?.definition.skillId).toBe('frontend');
  });
  it('keeps rubric ID/version immutable across different trials, while new criteria require contiguous versions', async () => {
    await save();
    const other = { ...input(), trialId: 'other-trial' };
    await save(publisher, other);
    const changed = {
      ...other,
      trialId: 'changed-trial',
      draft: {
        ...other.draft,
        rubric: {
          ...other.draft.rubric,
          criteria: [{ ...other.draft.rubric.criteria[0], description: 'Changed criterion' }],
        },
      },
    };
    await expect(save(publisher, changed)).rejects.toMatchObject({ code: 'RUBRIC_CONFLICT' });
    await expect(
      save(publisher, {
        ...changed,
        draft: {
          ...changed.draft,
          rubric: {
            ...changed.draft.rubric,
            reference: { recordId: 'synthetic-rubric', revision: 3 },
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'RUBRIC_REVISION_CHANGED' });
    await save(publisher, {
      ...changed,
      draft: {
        ...changed.draft,
        rubric: {
          ...changed.draft.rubric,
          reference: { recordId: 'synthetic-rubric', revision: 2 },
        },
      },
    });
    expect(await counts()).toEqual([
      { versions: 3, rubrics: 2, receipts: 4, audits: 4, outbox: 0 },
    ]);
  });
  it('rejects changed command identity, stale revisions and disabled writes while reauthorizing conflict', async () => {
    const key = randomUUID();
    await save(publisher, input(), key);
    await expect(save()).rejects.toMatchObject({ code: 'REVISION_CHANGED' });
    await expect(save(publisher, input(1), key)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    await expect(save(publisher, input(1), randomUUID(), false)).rejects.toMatchObject({
      code: 'WRITES_DISABLED',
    });
    allowed.clear();
    await expect(save(publisher, input(1), key)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it.each([0, 1])(
    'serializes actual independent publishers at trial revision %i with one winner',
    async (revision) => {
      if (revision) await save();
      const second = await actor();
      const results = await Promise.allSettled([
        save(publisher, input(revision)),
        save(second, input(revision)),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((r) => r.status === 'rejected')).toMatchObject({
        reason: { code: 'REVISION_CHANGED' },
      });
      expect((await read())?.definition.reference.revision).toBe(revision + 1);
    },
  );
  it('serializes duplicate receipt retries into one immutable publication', async () => {
    const key = randomUUID();
    const results = await Promise.all([
      save(publisher, input(), key),
      save(publisher, input(), key),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['EXECUTED', 'REPLAYED']);
    expect(results[0].trial).toEqual(results[1].trial);
    expect(await counts()).toEqual([
      { versions: 1, rubrics: 1, receipts: 2, audits: 2, outbox: 0 },
    ]);
  });
  async function hold(kind: 'user' | 'session' | 'catalog' | 'trial' | 'rubric') {
    let ready!: (pid: number) => void, release!: () => void, tx!: Prisma.TransactionClient;
    const started = new Promise<number>((r) => (ready = r)),
      gate = new Promise<void>((r) => (release = r));
    const held = locker.$transaction(async (current) => {
      tx = current;
      const [row] = await current.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() pid');
      if (kind === 'user')
        await current.$queryRawUnsafe(
          'SELECT "id" FROM "User" WHERE "id"=$1 FOR UPDATE',
          publisher.accountId,
        );
      else if (kind === 'session')
        await current.$queryRawUnsafe(
          'SELECT "tokenHash" FROM "Session" WHERE "tokenHash"=$1 FOR UPDATE',
          publisher.sessionHash,
        );
      else
        await current.$queryRawUnsafe(
          'SELECT pg_advisory_xact_lock(hashtextextended($1,$2::bigint))::text',
          kind === 'catalog' ? catalogId : kind === 'trial' ? trialId : 'synthetic-rubric',
          kind === 'catalog' ? 12012 : kind === 'trial' ? 12013 : 12014,
        );
      ready(row.pid);
      await gate;
    });
    const pid = await Promise.race([
      started,
      held.then(() => {
        throw Error('Lock holder ended before ready');
      }),
    ]);
    return {
      pid,
      release,
      held,
      mutate: (sql: string, ...bindings: string[]) => tx.$executeRawUnsafe(sql, ...bindings),
    };
  }
  async function blocked(pid: number) {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const [row] = await observer.$queryRawUnsafe<{ n: number }[]>(
        'SELECT count(*)::int n FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))',
        pid,
      );
      if (row.n > 0) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw Error('No actual PostgreSQL lock wait observed');
  }
  it.each(['catalog', 'trial', 'rubric'] as const)(
    'rechecks current policy after real %s wait and rolls back all prepared effects',
    async (kind) => {
      const lock = await hold(kind),
        pending = save().then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      try {
        await blocked(lock.pid);
        allowed.clear();
      } finally {
        lock.release();
        await lock.held;
      }
      expect(await pending).toMatchObject({ error: { code: 'FORBIDDEN' } });
      expect(await counts()).toEqual([
        { versions: 0, rubrics: 0, receipts: 1, audits: 1, outbox: 0 },
      ]);
    },
  );
  it.each(['user', 'session'] as const)(
    'observes authority revoked before the %s lock',
    async (kind) => {
      const lock = await hold(kind),
        pending = save().then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      try {
        await blocked(lock.pid);
        if (kind === 'user')
          await lock.mutate(
            'UPDATE "User" SET "role"=\'CREATOR\' WHERE "id"=$1',
            publisher.accountId,
          );
        else await lock.mutate('DELETE FROM "Session" WHERE "tokenHash"=$1', publisher.sessionHash);
      } finally {
        lock.release();
        await lock.held;
      }
      expect(await pending).toMatchObject({
        error: { code: kind === 'user' ? 'FORBIDDEN' : 'AUTHENTICATION_REQUIRED' },
      });
    },
  );
  it('expires the actual session during a rubric wait before publication can commit', async () => {
    await db.$executeRawUnsafe(
      `UPDATE "Session" SET "expiresAt"=(clock_timestamp() AT TIME ZONE 'UTC')+interval '400 milliseconds' WHERE "tokenHash"=$1`,
      publisher.sessionHash,
    );
    const lock = await hold('rubric'),
      pending = save().then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    try {
      await blocked(lock.pid);
      const deadline = Date.now() + 2000;
      let expired = false;
      while (Date.now() < deadline) {
        const [row] = await observer.$queryRawUnsafe<{ expired: boolean }[]>(
          `SELECT "expiresAt"<=(clock_timestamp() AT TIME ZONE 'UTC') expired FROM "Session" WHERE "tokenHash"=$1`,
          publisher.sessionHash,
        );
        if (row.expired) {
          expired = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(expired).toBe(true);
    } finally {
      lock.release();
      await lock.held;
    }
    expect(await pending).toMatchObject({ error: { code: 'AUTHENTICATION_REQUIRED' } });
    expect(await counts()).toEqual([
      { versions: 0, rubrics: 0, receipts: 1, audits: 1, outbox: 0 },
    ]);
  });
});
