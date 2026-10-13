import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { executeIdempotentCommand } from '../src/command-receipts';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { db } from '../src/lib/db';
import { hash } from '../src/lib/auth-primitives';
import {
  runCommandTransaction,
  createPrismaCommandTransaction,
} from '../src/lib/command-receipts-adapter';
import { publishSkillTaxonomy, type SkillTaxonomyActor } from '../src/skills/taxonomy-storage';
import { saveSkillClaim, readSkillClaim } from '../src/skills/claim-storage';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const category = {
  id: 'frontend',
  domain: 'software.frontend',
  name: 'Frontend',
  status: 'ACTIVE',
  aliases: ['frontend', 'web-ui'],
};
const catalogId = 'synthetic-skills';
async function actor(mapping = true, admin = false) {
  const user = await db.user.create({
    data: {
      handle: 'synthetic-claim',
      role: admin ? 'ADMIN' : 'CREATOR',
      xId: admin ? 'synthetic-' + randomUUID() : null,
    },
  });
  const sessionHash = hash(randomUUID());
  await db.session.create({
    data: {
      tokenHash: sessionHash,
      userId: user.id,
      via: 'wallet',
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  const p = mapping
    ? await db.participant.create({
        data: {
          accountId: user.id,
          provisionActorAccountId: user.id,
          provisionRequestId: 'synthetic-provision',
        },
      })
    : null;
  return { accountId: user.id, sessionHash, participantId: p?.id ?? null };
}
const catalog = (expectedRevision = 0, skills: unknown = [category], id = catalogId) =>
  runCommandTransaction(db, async (tx) => {
    const a = await actor(false, true);
    return publishSkillTaxonomy(
      tx,
      {
        actor: { accountId: a.accountId, sessionHash: a.sessionHash },
        input: { taxonomyId: id, expectedRevision, skills },
        idempotencyKey: randomUUID(),
        requestId: 'synthetic-catalog',
      },
      { allowNewWrites: true, canPublish: () => true },
    );
  });
const body = (expectedClaimRevision = 0, expectedTaxonomyRevision = 1, extra = {}) => ({
  taxonomyId: catalogId,
  expectedTaxonomyRevision,
  expectedClaimRevision,
  skillId: category.id,
  claimedLevel: ' S ',
  supportingReferences: [' https://public.example/portfolio '],
  ...extra,
});
const identity = (a: SkillTaxonomyActor) => ({
  accountId: a.accountId,
  sessionHash: a.sessionHash,
});
const save = (
  a: SkillTaxonomyActor,
  input: unknown = body(),
  key = randomUUID(),
  allowNewWrites = true,
) =>
  runCommandTransaction(db, (tx) =>
    saveSkillClaim(
      tx,
      { actor: identity(a), input, idempotencyKey: key, requestId: 'synthetic-claim-request' },
      { allowNewWrites },
    ),
  );
const read = (a: SkillTaxonomyActor, skillId = category.id) =>
  runCommandTransaction(db, (tx) => readSkillClaim(tx, identity(a), skillId));
const counts = () =>
  db.$queryRawUnsafe<
    { claims: number; versions: number; receipts: number; audits: number; outbox: number }[]
  >(
    `SELECT (SELECT count(*)::int FROM "SkillClaim") claims,(SELECT count(*)::int FROM "SkillClaimVersion") versions,(SELECT count(*)::int FROM "CommandReceipt" WHERE "commandKind"='SaveSkillClaim') receipts,(SELECT count(*)::int FROM "AuditEvent" WHERE "eventType"='skill.claim_recorded.v1') audits,(SELECT count(*)::int FROM "OutboxEvent") outbox`,
  );
integration('T012B2 private canonical unverified claim storage', () => {
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
    await catalog();
  });
  afterAll(() => Promise.all([db.$disconnect(), locker?.$disconnect(), observer?.$disconnect()]));
  it('stores an actual canonical private claim and normalized references without inventing assessment authority', async () => {
    const a = await actor(),
      r = await save(a);
    expect(r.status).toBe('EXECUTED');
    expect(r.claim).toMatchObject({
      version: 'v1',
      revision: 1,
      state: 'CLAIMED',
      participantId: a.participantId,
      skillId: 'frontend',
      skillDomain: 'software.frontend',
      claimedLevel: 'S',
      supportingReferences: ['https://public.example/portfolio'],
      taxonomyReference: { recordId: catalogId, revision: 1 },
      persisted: true,
      verifiesSkill: false,
      createsPermissionGrant: false,
      consumesCapacity: false,
      isAuthorizationToken: false,
    });
    expect(Object.isFrozen(r.claim)).toBe(true);
    for (const field of ['assessedRank', 'assessmentHistory', 'rubric', 'evaluator', 'confidence'])
      expect(r.claim).not.toHaveProperty(field);
    expect(await read(a)).toEqual(r.claim);
    expect(await counts()).toEqual([{ claims: 1, versions: 1, receipts: 1, audits: 1, outbox: 0 }]);
  });
  it('keeps one canonical claim across independent wallet and X session credentials', async () => {
    const a = await actor(),
      first = await save(a),
      other = hash(randomUUID());
    await db.session.create({
      data: {
        tokenHash: other,
        userId: a.accountId,
        via: 'x',
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    const second = await save(
      { ...a, sessionHash: other },
      body(1, 1, { claimedLevel: 'Updated claim', supportingReferences: [] }),
    );
    expect(second.claim).toMatchObject({
      id: first.claim.id,
      participantId: a.participantId,
      revision: 2,
      claimedLevel: 'Updated claim',
    });
    expect(await counts()).toEqual([{ claims: 1, versions: 2, receipts: 2, audits: 2, outbox: 0 }]);
  });
  it('replays the original immutable result after a later claim/catalog retirement and writes disabled', async () => {
    const a = await actor(),
      key = randomUUID(),
      first = await save(a, body(), key);
    const second = await save(a, body(1, 1, { claimedLevel: 'C' }));
    await catalog(1, [{ ...category, status: 'RETIRED' }]);
    expect(await save(a, body(), key, false)).toEqual({ status: 'REPLAYED', claim: first.claim });
    expect(await read(a)).toEqual(second.claim);
    await expect(save(a, body(2, 2))).rejects.toMatchObject({ code: 'SKILL_UNAVAILABLE' });
    expect(await counts()).toEqual([{ claims: 1, versions: 2, receipts: 2, audits: 2, outbox: 0 }]);
  });
  it('rejects unknown skill/catalog/missing canonical mapping without provisioning or prepared effects', async () => {
    const a = await actor();
    await expect(save(a, body(0, 1, { skillId: 'solana' }))).rejects.toMatchObject({
      code: 'SKILL_UNAVAILABLE',
    });
    await expect(save(a, body(0, 1, { taxonomyId: 'unknown' }))).rejects.toMatchObject({
      code: 'RESOURCE_UNAVAILABLE',
    });
    const missing = await actor(false);
    await expect(save(missing)).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
    await expect(read(missing)).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
    expect(await db.participant.findUnique({ where: { accountId: missing.accountId } })).toBeNull();
    expect(await counts()).toEqual([{ claims: 0, versions: 0, receipts: 0, audits: 0, outbox: 0 }]);
  });
  it.each(['expired', 'revoked', 'foreign', 'unsupported', 'restricted'])(
    'denies current %s authority on save/read/original replay',
    async (kind) => {
      const a = await actor(),
        key = randomUUID();
      await save(a, body(), key);
      if (kind === 'expired')
        await db.session.update({
          where: { tokenHash: a.sessionHash },
          data: { expiresAt: new Date(0) },
        });
      if (kind === 'revoked') await db.session.delete({ where: { tokenHash: a.sessionHash } });
      if (kind === 'foreign') a.sessionHash = (await actor()).sessionHash;
      if (kind === 'unsupported')
        await db.session.update({ where: { tokenHash: a.sessionHash }, data: { via: 'forged' } });
      if (kind === 'restricted')
        await db.user.update({ where: { id: a.accountId }, data: { suspended: true } });
      const code = kind === 'restricted' ? 'ACCOUNT_RESTRICTED' : 'AUTHENTICATION_REQUIRED';
      await Promise.all(
        [save(a, body(1)), save(a, body(), key, false), read(a)].map((work) =>
          expect(work).rejects.toMatchObject({ code }),
        ),
      );
      expect(await counts()).toEqual([
        { claims: 1, versions: 1, receipts: 1, audits: 1, outbox: 0 },
      ]);
    },
  );
  it('keeps other canonical participants private and permits empty own history', async () => {
    const a = await actor(),
      b = await actor();
    expect(await read(a)).toBeNull();
    await save(a);
    expect(await read(b)).toBeNull();
    expect(await read(a, 'another-skill')).toBeNull();
  });
  it.each([
    'participantId',
    'accountId',
    'wallet',
    'verified',
    'assessedRank',
    'rubric',
    'assessmentHistory',
    'recordedAt',
  ])('rejects claimant-injected %s authority', async (field) => {
    const a = await actor();
    await expect(save(a, body(0, 1, { [field]: 'forged' }))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(await counts()).toEqual([{ claims: 0, versions: 0, receipts: 0, audits: 0, outbox: 0 }]);
  });
  it('pins current catalog and claim revisions and original-body digest without leaking stale conflicts after expiry', async () => {
    const a = await actor(),
      key = randomUUID();
    await save(a, body(), key);
    await expect(save(a)).rejects.toMatchObject({ code: 'REVISION_CHANGED' });
    await expect(save(a, body(1, 2))).rejects.toMatchObject({ code: 'REVISION_CHANGED' });
    await expect(save(a, body(1), key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await db.session.delete({ where: { tokenHash: a.sessionHash } });
    await expect(save(a, body(1), key)).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
  });
  it('rejects new writes disabled and invalid references while preserving private original receipts', async () => {
    const a = await actor();
    await expect(save(a, body(), randomUUID(), false)).rejects.toMatchObject({
      code: 'WRITES_DISABLED',
    });
    for (const supportingReferences of [
      ['http://public.example'],
      ['https://u:secret@public.example'],
      ['https://public.example', 'https://public.example/'],
    ])
      await expect(save(a, body(0, 1, { supportingReferences }))).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    expect(await counts()).toEqual([{ claims: 0, versions: 0, receipts: 0, audits: 0, outbox: 0 }]);
  });
  it('serializes competing initial claims and same-identity retries without extra records', async () => {
    const a = await actor(),
      r = await Promise.allSettled([save(a), save(a)]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(r.find((x) => x.status === 'rejected')).toMatchObject({
      reason: { code: 'REVISION_CHANGED' },
    });
    const key = randomUUID(),
      values = await Promise.all([save(a, body(1), key), save(a, body(1), key)]);
    expect(values.map((x) => x.status).sort()).toEqual(['EXECUTED', 'REPLAYED']);
    expect(values[0].claim).toEqual(values[1].claim);
    expect(await counts()).toEqual([{ claims: 1, versions: 2, receipts: 2, audits: 2, outbox: 0 }]);
  });
  it('preserves original domain and catalog identity instead of moving a claim to another catalog', async () => {
    const a = await actor();
    await save(a);
    await catalog(0, [category], 'other-catalog');
    await expect(save(a, body(1, 1, { taxonomyId: 'other-catalog' }))).rejects.toMatchObject({
      code: 'HISTORY_CONFLICT',
    });
    expect(await counts()).toEqual([{ claims: 1, versions: 1, receipts: 1, audits: 1, outbox: 0 }]);
  });
  async function hold(a: SkillTaxonomyActor, kind: 'catalog' | 'claim' | 'user' | 'session') {
    let ready!: (pid: number) => void, release!: () => void, current!: Prisma.TransactionClient;
    const started = new Promise<number>((r) => (ready = r)),
      gate = new Promise<void>((r) => (release = r));
    const held = locker.$transaction(async (tx) => {
      const [row] = await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
      if (kind === 'catalog')
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "SkillTaxonomy" WHERE "id"=$1 FOR UPDATE',
          catalogId,
        );
      if (kind === 'claim')
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "SkillClaim" WHERE "accountId"=$1 FOR UPDATE',
          a.accountId,
        );
      if (kind === 'user')
        await tx.$queryRawUnsafe('SELECT "id" FROM "User" WHERE "id"=$1 FOR UPDATE', a.accountId);
      if (kind === 'session')
        await tx.$queryRawUnsafe(
          'SELECT "tokenHash" FROM "Session" WHERE "tokenHash"=$1 FOR UPDATE',
          a.sessionHash,
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
    const end = Date.now() + 2000;
    while (Date.now() < end) {
      const rows = await observer.$queryRawUnsafe<{ n: number }[]>(
        'SELECT count(*)::int n FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))',
        pid,
      );
      if (rows[0].n > 0) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw Error('No actual claim lock wait observed');
  }
  it.each(['catalog', 'claim'] as const)(
    'reauthorizes actual session expiry after waiting for %s',
    async (kind) => {
      const a = await actor();
      await save(a);
      await db.$executeRawUnsafe(
        `UPDATE "Session" SET "expiresAt"=(clock_timestamp() AT TIME ZONE 'UTC')+interval '400 milliseconds' WHERE "tokenHash"=$1`,
        a.sessionHash,
      );
      const lock = await hold(a, kind),
        pending = save(a, body(1)).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      try {
        await waitBlocked(lock.pid);
        const end = Date.now() + 2000;
        while (Date.now() < end) {
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
      expect(await counts()).toEqual([
        { claims: 1, versions: 1, receipts: 1, audits: 1, outbox: 0 },
      ]);
    },
  );
  it.each(['user', 'session'] as const)(
    'observes current %s revocation that commits before its authority lock',
    async (kind) => {
      const a = await actor(),
        lock = await hold(a, kind),
        pending = save(a).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      try {
        await waitBlocked(lock.pid);
        if (kind === 'user')
          await lock.mutate('UPDATE "User" SET "suspended"=true WHERE "id"=$1', a.accountId);
        else await lock.mutate('DELETE FROM "Session" WHERE "tokenHash"=$1', a.sessionHash);
      } finally {
        lock.release();
        await lock.held;
      }
      expect(await pending).toMatchObject({
        error: { code: kind === 'user' ? 'ACCOUNT_RESTRICTED' : 'AUTHENTICATION_REQUIRED' },
      });
      expect(await counts()).toEqual([
        { claims: 0, versions: 0, receipts: 0, audits: 0, outbox: 0 },
      ]);
    },
  );
  type Patch = {
    accountId?: string;
    participantId?: string;
    skillId?: string;
    skillDomain?: string;
    taxonomyVersionId?: string;
    taxonomyRevision?: number;
    revision?: number;
    claimedLevel?: string;
    references?: unknown;
    omitProjection?: boolean;
    kind?: string;
    payload?: Record<string, string>;
    publish?: boolean;
  };
  const direct = (a: SkillTaxonomyActor, patch: Patch = {}) =>
    db.$transaction(async (tx) =>
      executeIdempotentCommand(
        createPrismaCommandTransaction(tx),
        {
          actorId: a.accountId,
          commandKind: patch.kind ?? 'SaveSkillClaim',
          idempotencyKey: randomUUID(),
          requestId: 'sql-probe',
          request: {},
        },
        async ({ receiptId }) => {
          const [c] = await tx.$queryRawUnsafe<
            {
              id: string;
              participantId: string;
              skillId: string;
              skillDomain: string;
              taxonomyId: string;
              taxonomyVersionId: string;
              taxonomyRevision: number;
            }[]
          >(
            `SELECT c."id"::text,c."participantId"::text,c."skillId",c."skillDomain",c."taxonomyId",t."currentVersionId"::text AS "taxonomyVersionId",t."revision" AS "taxonomyRevision" FROM "SkillClaim" c JOIN "SkillTaxonomy" t ON t."id"=c."taxonomyId" WHERE c."accountId"=$1`,
            a.accountId,
          );
          const revision = patch.revision ?? 2;
          const [v] = await tx.$queryRawUnsafe<{ id: string }[]>(
            `INSERT INTO "SkillClaimVersion"("skillClaimId","accountId","participantId","skillId","skillDomain","taxonomyId","taxonomyVersionId","taxonomyRevision","revision","claimedLevel","supportingReferences","receiptId","actorAccountId","requestId") VALUES($1::uuid,$2,$3::uuid,$4,$5,$6,$7::uuid,$8::int,$9::int,$10,$11::jsonb,$12::uuid,$2,'sql-probe') RETURNING "id"::text`,
            c.id,
            patch.accountId ?? a.accountId,
            patch.participantId ?? c.participantId,
            patch.skillId ?? c.skillId,
            patch.skillDomain ?? c.skillDomain,
            c.taxonomyId,
            patch.taxonomyVersionId ?? c.taxonomyVersionId,
            patch.taxonomyRevision ?? c.taxonomyRevision,
            revision,
            patch.claimedLevel ?? 'Raw claim assertion',
            JSON.stringify(patch.references ?? []),
            receiptId,
          );
          if (!patch.omitProjection)
            await tx.$executeRawUnsafe(
              'UPDATE "SkillClaim" SET "revision"=$2::int,"currentVersionId"=$3::uuid WHERE "id"=$1::uuid',
              c.id,
              revision,
              v.id,
            );
          return {
            resultRef: v.id,
            events: [
              {
                type: 'skill.claim_recorded.v1',
                aggregateId: c.id,
                aggregateVersion: revision,
                payload: patch.payload ?? { skillClaimVersionId: v.id },
                publish: patch.publish ?? false,
              },
            ],
          };
        },
      ),
    );
  it('proves direct SQL probes can commit valid claimant fields with the exact required provenance', async () => {
    const a = await actor();
    await save(a);
    await direct(a);
    expect(await read(a)).toMatchObject({
      revision: 2,
      claimedLevel: 'Raw claim assertion',
      verifiesSkill: false,
    });
  });
  it.each([
    'owner',
    'participant',
    'skill',
    'domain',
    'revision',
    'level',
    'references',
    'projection',
    'kind',
    'payload',
    'outbox',
  ])(
    'database rejects direct %s violations and retains original private history',
    async (violation) => {
      const a = await actor(),
        first = await save(a),
        patch: Patch = {};
      if (violation === 'owner') patch.accountId = (await actor()).accountId;
      if (violation === 'participant') patch.participantId = (await actor()).participantId!;
      if (violation === 'skill') patch.skillId = 'solana';
      if (violation === 'domain') patch.skillDomain = 'blockchain.solana';
      if (violation === 'revision') patch.revision = 3;
      if (violation === 'level') patch.claimedLevel = '';
      if (violation === 'references') patch.references = ['https://u:secret@public.example/'];
      if (violation === 'projection') patch.omitProjection = true;
      if (violation === 'kind') patch.kind = 'WrongClaimCommand';
      if (violation === 'payload') patch.payload = { claimId: 'wrong-ref' };
      if (violation === 'outbox') patch.publish = true;
      await expect(direct(a, patch)).rejects.toThrow();
      expect(await read(a)).toEqual(first.claim);
      expect(await counts()).toEqual([
        { claims: 1, versions: 1, receipts: 1, audits: 1, outbox: 0 },
      ]);
    },
  );
  it('database denies using an old active snapshot after current category retirement', async () => {
    const a = await actor(),
      first = await save(a);
    const [old] = await db.$queryRawUnsafe<{ id: string }[]>(
      'SELECT "id"::text FROM "SkillTaxonomyVersion" WHERE "taxonomyId"=$1 AND "revision"=1',
      catalogId,
    );
    await catalog(1, [{ ...category, status: 'RETIRED' }]);
    await expect(direct(a, { taxonomyVersionId: old.id, taxonomyRevision: 1 })).rejects.toThrow();
    expect(await read(a)).toEqual(first.claim);
    expect(await counts()).toEqual([{ claims: 1, versions: 1, receipts: 1, audits: 1, outbox: 0 }]);
  });
  it.each([
    'UPDATE "SkillClaimVersion" SET "claimedLevel"=\'tampered\'',
    'DELETE FROM "SkillClaimVersion"',
    'UPDATE "SkillClaim" SET "skillDomain"=\'other\'',
    'UPDATE "SkillClaim" SET "revision"=3',
    'DELETE FROM "SkillClaim"',
  ])('database refuses historical identity/version damage: %s', async (sql) => {
    const a = await actor(),
      first = await save(a);
    await expect(db.$executeRawUnsafe(sql)).rejects.toThrow();
    expect(await read(a)).toEqual(first.claim);
  });
});
