import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { executeIdempotentCommand } from '../src/command-receipts';
import { db } from '../src/lib/db';
import { hash } from '../src/lib/auth-primitives';
import {
  runCommandTransaction,
  createPrismaCommandTransaction,
} from '../src/lib/command-receipts-adapter';
import {
  publishSkillTaxonomy,
  readPublishedSkillTaxonomy,
  type SkillTaxonomyActor,
} from '../src/skills/taxonomy-storage';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const skills = [
  {
    id: 'frontend',
    domain: 'software.frontend',
    name: 'Frontend',
    status: 'ACTIVE',
    aliases: ['frontend', 'web-ui'],
  },
  {
    id: 'solana',
    domain: 'blockchain.solana',
    name: 'Solana',
    status: 'ACTIVE',
    aliases: ['solana'],
  },
];
const id = 'synthetic-catalog';
let allowed = new Set<string>();
async function actor(admin = true, patch = {}) {
  const xId = 'synthetic-' + randomUUID();
  const user = await db.user.create({
    data: { handle: 'synthetic', role: admin ? 'ADMIN' : 'CREATOR', xId, ...patch },
  });
  allowed.add(xId);
  const sessionHash = hash(randomUUID());
  await db.session.create({
    data: {
      tokenHash: sessionHash,
      userId: user.id,
      via: 'wallet',
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  return { accountId: user.id, sessionHash };
}
const body = (expectedRevision = 0, categories: unknown = skills) => ({
  taxonomyId: id,
  expectedRevision,
  skills: categories,
});
const save = (
  a: SkillTaxonomyActor,
  input: unknown = body(),
  key = randomUUID(),
  allowNewWrites = true,
) =>
  runCommandTransaction(db, (tx) =>
    publishSkillTaxonomy(
      tx,
      { actor: a, input, idempotencyKey: key, requestId: 'synthetic-request' },
      { allowNewWrites, canPublish: (user) => allowed.has(user.xId) },
    ),
  );
const read = (a: SkillTaxonomyActor, catalogId = id) =>
  runCommandTransaction(db, (tx) => readPublishedSkillTaxonomy(tx, a, catalogId));
const counts = () =>
  db.$queryRawUnsafe<{ versions: number; receipts: number; audits: number; outbox: number }[]>(
    `SELECT (SELECT count(*)::int FROM "SkillTaxonomyVersion") versions,(SELECT count(*)::int FROM "CommandReceipt") receipts,(SELECT count(*)::int FROM "AuditEvent") audits,(SELECT count(*)::int FROM "OutboxEvent") outbox`,
  );
integration('T012B1 durable authorized taxonomy', () => {
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
  });
  afterAll(() => Promise.all([db.$disconnect(), locker?.$disconnect(), observer?.$disconnect()]));
  it('publishes an actual actor-attributed immutable catalog and private audit without any outbox', async () => {
    const a = await actor(),
      value = await save(a);
    expect(value.status).toBe('EXECUTED');
    expect(value.taxonomy).toMatchObject({
      version: 'v1',
      id,
      revision: 1,
      state: 'PUBLISHED',
      publishedByAccountId: a.accountId,
      skills,
    });
    expect(Number.isNaN(Date.parse(value.taxonomy.publishedAt))).toBe(false);
    expect(Object.isFrozen(value.taxonomy)).toBe(true);
    expect(await counts()).toEqual([{ versions: 1, receipts: 1, audits: 1, outbox: 0 }]);
    expect(await read(a)).toEqual(value.taxonomy);
  });
  it('reads absent catalogs as null and lets a current ordinary account read saved catalog data', async () => {
    const ordinary = await actor(false);
    expect(await read(ordinary)).toBeNull();
    const first = await save(await actor());
    expect(await read(ordinary)).toEqual(first.taxonomy);
  });
  it('retains original receipts and historical snapshots after rename/retirement and writes disabled', async () => {
    const a = await actor(),
      key = randomUUID(),
      first = await save(a, body(), key);
    const changed = [
      {
        ...skills[0],
        name: 'Web interfaces',
        status: 'RETIRED',
        aliases: [...skills[0].aliases, 'react-ui'],
      },
      skills[1],
    ];
    const second = await save(a, body(1, changed));
    expect(second.taxonomy).toMatchObject({ revision: 2, skills: changed });
    expect(await save(a, body(), key, false)).toEqual({
      status: 'REPLAYED',
      taxonomy: first.taxonomy,
    });
    expect(await read(a)).toEqual(second.taxonomy);
    expect(await counts()).toEqual([{ versions: 2, receipts: 2, audits: 2, outbox: 0 }]);
  });
  it.each(['role', 'xId', 'allowlist', 'suspended'])(
    'rejects publication and replay when current %s authority is removed',
    async (field) => {
      const a = await actor(),
        key = randomUUID();
      await save(a, body(), key);
      if (field === 'allowlist') allowed.clear();
      else
        await db.user.update({
          where: { id: a.accountId },
          data:
            field === 'role'
              ? { role: 'CREATOR' }
              : field === 'xId'
                ? { xId: null }
                : { suspended: true },
        });
      const code = field === 'suspended' ? 'ACCOUNT_RESTRICTED' : 'FORBIDDEN';
      await expect(save(a, body(), key, false)).rejects.toMatchObject({ code });
      await expect(save(a, body(1))).rejects.toMatchObject({ code });
      expect(await counts()).toEqual([{ versions: 1, receipts: 1, audits: 1, outbox: 0 }]);
    },
  );
  it.each(['foreign', 'expired', 'revoked', 'invalid-via'])(
    'denies %s sessions on publish, replay and read',
    async (kind) => {
      const a = await actor(),
        key = randomUUID();
      await save(a, body(), key);
      if (kind === 'foreign') a.sessionHash = (await actor()).sessionHash;
      if (kind === 'expired')
        await db.session.update({
          where: { tokenHash: a.sessionHash },
          data: { expiresAt: new Date(0) },
        });
      if (kind === 'revoked') await db.session.delete({ where: { tokenHash: a.sessionHash } });
      if (kind === 'invalid-via')
        await db.session.update({ where: { tokenHash: a.sessionHash }, data: { via: 'forged' } });
      await Promise.all(
        [save(a, body(), key), save(a, body(1)), read(a)].map((work) =>
          expect(work).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' }),
        ),
      );
    },
  );
  it('denies role-only/ordinary/holder-like actors, and exposes digest conflicts only to current authorized publishers', async () => {
    await expect(save(await actor(false))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const a = await actor(),
      key = randomUUID();
    await save(a, body(), key);
    await expect(save(a, body(1), key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    allowed.clear();
    await expect(save(a, body(1), key)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it.each(['id', 'domain', 'alias'])(
    'rejects loss or reassignment of stable %s history without prepared effects',
    async (field) => {
      const a = await actor();
      await save(a);
      const changed = skills.map((s) => ({ ...s, aliases: [...s.aliases] }));
      if (field === 'id') changed.shift();
      if (field === 'domain') changed[0].domain = 'blockchain.solana';
      if (field === 'alias') changed[0].aliases = ['new-alias'];
      await expect(save(a, body(1, changed))).rejects.toMatchObject({ code: 'HISTORY_CONFLICT' });
      expect(await counts()).toEqual([{ versions: 1, receipts: 1, audits: 1, outbox: 0 }]);
    },
  );
  it('rejects stale revisions/new disabled writes and rejects client publication/admin fields', async () => {
    const a = await actor();
    await save(a);
    await expect(save(a)).rejects.toMatchObject({ code: 'REVISION_CHANGED' });
    await expect(save(a, body(1), randomUUID(), false)).rejects.toMatchObject({
      code: 'WRITES_DISABLED',
    });
    for (const field of ['publishedByAccountId', 'publishedAt', 'isAdmin', 'state', 'assessedRank'])
      await expect(save(a, { ...body(1), [field]: 'forged' })).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    expect(await counts()).toEqual([{ versions: 1, receipts: 1, audits: 1, outbox: 0 }]);
  });
  it.each([0, 1])(
    'serializes two different admins at revision %i with exactly one winner',
    async (revision) => {
      const a = await actor(),
        b = await actor();
      if (revision) await save(a);
      const result = await Promise.allSettled([save(a, body(revision)), save(b, body(revision))]);
      expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = result.find((r) => r.status === 'rejected');
      expect(rejected).toMatchObject({ reason: { code: 'REVISION_CHANGED' } });
      expect((await read(a))?.revision).toBe(revision + 1);
      expect(await counts()).toEqual([
        { versions: revision + 1, receipts: revision + 1, audits: revision + 1, outbox: 0 },
      ]);
    },
  );
  it('concurrent same-identity retries publish one immutable result', async () => {
    const a = await actor(),
      key = randomUUID();
    const results = await Promise.all([save(a, body(), key), save(a, body(), key)]);
    expect(results.map((r) => r.status).sort()).toEqual(['EXECUTED', 'REPLAYED']);
    expect(results[0].taxonomy).toEqual(results[1].taxonomy);
    expect(await counts()).toEqual([{ versions: 1, receipts: 1, audits: 1, outbox: 0 }]);
  });
  async function hold(a: SkillTaxonomyActor, kind: 'user' | 'session' | 'catalog' | 'advisory') {
    let ready!: (pid: number) => void, release!: () => void, current!: Prisma.TransactionClient;
    const started = new Promise<number>((r) => (ready = r)),
      gate = new Promise<void>((r) => (release = r));
    const held = locker.$transaction(async (tx) => {
      const [row] = await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
      if (kind === 'user')
        await tx.$queryRawUnsafe('SELECT "id" FROM "User" WHERE "id"=$1 FOR UPDATE', a.accountId);
      if (kind === 'session')
        await tx.$queryRawUnsafe(
          'SELECT "tokenHash" FROM "Session" WHERE "tokenHash"=$1 FOR UPDATE',
          a.sessionHash,
        );
      if (kind === 'catalog')
        await tx.$queryRawUnsafe('SELECT "id" FROM "SkillTaxonomy" WHERE "id"=$1 FOR UPDATE', id);
      if (kind === 'advisory')
        await tx.$queryRawUnsafe(
          'SELECT pg_advisory_xact_lock(hashtextextended($1,12012))::text',
          id,
        );
      current = tx;
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
      mutate: (sql: string, ...args: string[]) => current.$executeRawUnsafe(sql, ...args),
    };
  }
  async function waitBlocked(pid: number) {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const rows = await observer.$queryRawUnsafe<{ n: number }[]>(
        'SELECT count(*)::int n FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))',
        pid,
      );
      if (rows[0].n > 0) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw Error('No actual database lock wait observed');
  }
  it.each(['catalog', 'advisory'] as const)(
    'rolls back session expiry while waiting on the %s lock',
    async (kind) => {
      const a = await actor();
      await save(a);
      await db.$executeRawUnsafe(
        `UPDATE "Session" SET "expiresAt"=(clock_timestamp() AT TIME ZONE 'UTC')+interval '400 milliseconds' WHERE "tokenHash"=$1`,
        a.sessionHash,
      );
      const lock = await hold(a, kind);
      const pending = save(a, body(1)).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      try {
        await waitBlocked(lock.pid);
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          const [row] = await observer.$queryRawUnsafe<{ expired: boolean }[]>(
            `SELECT "expiresAt"<=(clock_timestamp() AT TIME ZONE 'UTC') expired FROM "Session" WHERE "tokenHash"=$1`,
            a.sessionHash,
          );
          if (row.expired) break;
          await new Promise((r) => setTimeout(r, 10));
        }
      } finally {
        lock.release();
        await lock.held;
      }
      expect(await pending).toMatchObject({ error: { code: 'AUTHENTICATION_REQUIRED' } });
      expect(await counts()).toEqual([{ versions: 1, receipts: 1, audits: 1, outbox: 0 }]);
    },
  );
  it('rechecks scoped policy after an actual advisory lock wait', async () => {
    const a = await actor(),
      lock = await hold(a, 'advisory');
    const pending = save(a).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      await waitBlocked(lock.pid);
      allowed.clear();
    } finally {
      lock.release();
      await lock.held;
    }
    expect(await pending).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(await counts()).toEqual([{ versions: 0, receipts: 0, audits: 0, outbox: 0 }]);
  });
  it.each(['user', 'session'] as const)(
    'observes current authority changed before acquiring the %s lock',
    async (kind) => {
      const a = await actor(),
        lock = await hold(a, kind);
      const pending = save(a).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      try {
        await waitBlocked(lock.pid);
        if (kind === 'user')
          await lock.mutate('UPDATE "User" SET "role"=\'CREATOR\' WHERE "id"=$1', a.accountId);
        else await lock.mutate('DELETE FROM "Session" WHERE "tokenHash"=$1', a.sessionHash);
      } finally {
        lock.release();
        await lock.held;
      }
      expect(await pending).toMatchObject({
        error: { code: kind === 'user' ? 'FORBIDDEN' : 'AUTHENTICATION_REQUIRED' },
      });
      expect(await counts()).toEqual([{ versions: 0, receipts: 0, audits: 0, outbox: 0 }]);
    },
  );
  const direct = (
    a: SkillTaxonomyActor,
    patch: {
      categories?: unknown;
      revision?: number;
      omitProjection?: boolean;
      kind?: string;
      auditActor?: string;
      payload?: Record<string, string>;
      publish?: boolean;
    } = {},
  ) =>
    db.$transaction(async (tx) =>
      executeIdempotentCommand(
        createPrismaCommandTransaction(tx),
        {
          actorId: a.accountId,
          commandKind: patch.kind ?? 'PublishSkillTaxonomy',
          idempotencyKey: randomUUID(),
          requestId: 'sql-probe',
          request: {},
        },
        async ({ receiptId }) => {
          const revision = patch.revision ?? 2;
          const [v] = await tx.$queryRawUnsafe<{ id: string }[]>(
            `INSERT INTO "SkillTaxonomyVersion"("taxonomyId","revision","skills","receiptId","publishedByAccountId","requestId") VALUES($1,$2::int,$3::jsonb,$4::uuid,$5,'sql-probe') RETURNING "id"::text`,
            id,
            revision,
            JSON.stringify(patch.categories ?? skills),
            receiptId,
            patch.auditActor ?? a.accountId,
          );
          if (!patch.omitProjection)
            await tx.$executeRawUnsafe(
              'UPDATE "SkillTaxonomy" SET "revision"=$2::int,"currentVersionId"=$3::uuid WHERE "id"=$1',
              id,
              revision,
              v.id,
            );
          return {
            resultRef: v.id,
            events: [
              {
                type: 'skill.taxonomy_published.v1',
                aggregateId: id,
                aggregateVersion: revision,
                payload: patch.payload ?? { skillTaxonomyVersionId: v.id },
                publish: patch.publish ?? false,
              },
            ],
          };
        },
      ),
    );
  it('proves the direct SQL probe can commit a valid next version with its required receipt and private audit', async () => {
    const a = await actor();
    await save(a);
    await direct(a);
    expect((await read(a))?.revision).toBe(2);
  });
  it.each([
    'id',
    'domain',
    'alias',
    'duplicate',
    'shape',
    'revision',
    'projection',
    'kind',
    'actor',
    'payload',
    'outbox',
  ])(
    'database rejects a direct %s violation and rolls back its receipt/audit',
    async (violation) => {
      const a = await actor();
      await save(a);
      const before = await counts();
      const patch: Parameters<typeof direct>[1] = {};
      if (violation === 'id') patch.categories = skills.slice(1);
      if (violation === 'domain') patch.categories = [{ ...skills[0], domain: 'other' }, skills[1]];
      if (violation === 'alias') patch.categories = [{ ...skills[0], aliases: ['new'] }, skills[1]];
      if (violation === 'duplicate')
        patch.categories = [skills[0], { ...skills[1], aliases: ['frontend'] }];
      if (violation === 'shape') patch.categories = [{ ...skills[0], rank: 'S' }, skills[1]];
      if (violation === 'revision') patch.revision = 3;
      if (violation === 'projection') patch.omitProjection = true;
      if (violation === 'kind') patch.kind = 'WrongCatalogCommand';
      if (violation === 'actor') patch.auditActor = (await actor()).accountId;
      if (violation === 'payload') patch.payload = { operationId: 'unrelated' };
      if (violation === 'outbox') patch.publish = true;
      await expect(direct(a, patch)).rejects.toThrow();
      expect(await counts()).toEqual(before);
      expect((await read(a))?.revision).toBe(1);
    },
  );
  it.each([
    'UPDATE "SkillTaxonomyVersion" SET "skills"=\'[]\'::jsonb',
    'DELETE FROM "SkillTaxonomyVersion"',
    'UPDATE "SkillTaxonomy" SET "id"=\'changed\'',
    'UPDATE "SkillTaxonomy" SET "revision"=3',
    'DELETE FROM "SkillTaxonomy"',
  ])('database protects retained history: %s', async (sql) => {
    const a = await actor();
    const first = await save(a);
    await expect(db.$executeRawUnsafe(sql)).rejects.toThrow();
    expect(await read(a)).toEqual(first.taxonomy);
    expect(await counts()).toEqual([{ versions: 1, receipts: 1, audits: 1, outbox: 0 }]);
  });
});
