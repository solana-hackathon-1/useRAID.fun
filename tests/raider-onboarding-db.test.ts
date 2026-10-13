import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { db } from '../src/lib/db';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { ensureHumanParticipant } from '../src/identity-storage';
import { createPrismaIdentityTransaction } from '../src/lib/identity-storage-adapter';
import { CommandReceiptError } from '../src/command-receipts';
import { saveRaiderOrientation, readRaiderOrientation } from '../src/raider-onboarding/storage';
import type { OrientationActor } from '../src/raider-onboarding/storage';
import type { RaiderOnboardingHost } from '../src/raider-onboarding';
import { hash } from '../src/lib/auth-primitives';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const locker = new PrismaClient({ transactionOptions: { timeout: 15000 } });
const observer = new PrismaClient();
const host: RaiderOnboardingHost = {
  version: 'v1',
  interestIds: ['frontend', 'qa'],
  nextActions: {
    starterTasks: { available: false, reason: 'NOT_READY' },
    portfolio: { available: false, reason: 'NOT_CONFIGURED' },
    trial: { available: false, reason: 'NOT_READY' },
  },
};
const preferences = {
  experience: 'BEGINNER',
  workInterests: ['qa', 'frontend', 'qa'],
  timezone: 'Asia/Kathmandu',
  orientationAcknowledged: true,
};
const body = (revision = 0, extra = {}) => ({
  expectedRevision: revision,
  preferences: { ...preferences, ...extra },
});
let counter = 0;
async function actor(via = 'wallet'): Promise<OrientationActor> {
  const user = await db.user.create({ data: { handle: 'synthetic-orientation-' + ++counter } });
  const sessionHash = hash(user.id);
  await db.session.create({
    data: { userId: user.id, tokenHash: sessionHash, via, expiresAt: new Date(Date.now() + 60000) },
  });
  return { accountId: user.id, actorAccountId: user.id, sessionHash };
}
const save = (a: OrientationActor, input: unknown = body(), key = 'orientation-1') =>
  runCommandTransaction(db, (tx) =>
    saveRaiderOrientation(
      tx,
      { actor: a, input, idempotencyKey: key, requestId: 'request-' + key },
      host,
    ),
  );
const read = (a: OrientationActor) =>
  runCommandTransaction(db, (tx) => readRaiderOrientation(tx, a));
async function counts() {
  const [row] = await db.$queryRawUnsafe<Record<string, number>[]>(
    `SELECT (SELECT count(*)::int FROM "RaiderPreferenceVersion") AS versions,(SELECT count(*)::int FROM "RaiderPreferences") AS profiles,(SELECT count(*)::int FROM "Participant") AS participants,(SELECT count(*)::int FROM "CommandReceipt") AS receipts,(SELECT count(*)::int FROM "AuditEvent") AS audits,(SELECT count(*)::int FROM "OutboxEvent") AS outbox`,
  );
  return row;
}
async function hold(a: OrientationActor, session = false) {
  let ready!: (pid: number) => void;
  let release!: () => void;
  let heldTx!: Prisma.TransactionClient;
  const started = new Promise<number>((r) => (ready = r));
  const gate = new Promise<void>((r) => (release = r));
  const held = locker.$transaction(async (tx) => {
    const [row] = await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
    if (session)
      await tx.$queryRawUnsafe(
        'SELECT "tokenHash" FROM "Session" WHERE "tokenHash"=$1 FOR UPDATE',
        a.sessionHash,
      );
    else
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "User" WHERE "id"=$1 FOR NO KEY UPDATE',
        a.accountId,
      );
    heldTx = tx;
    ready(row.pid);
    await gate;
  });
  return {
    pid: await started,
    release,
    held,
    mutate: (sql: string, ...bindings: string[]) => heldTx.$executeRawUnsafe(sql, ...bindings),
  };
}
async function blocked(pid: number, query: string) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const rows = await observer.$queryRawUnsafe<{ pid: number; query: string }[]>(
      'SELECT pid,query FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))',
      pid,
    );
    const waiter = rows.find((r) => r.query.includes(query));
    if (waiter) {
      expect(waiter.pid).not.toBe(pid);
      console.info(
        JSON.stringify({ orientationLock: { blocker: pid, waiter: waiter.pid, query } }),
      );
      return waiter.pid;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('No observed PostgreSQL ' + query + ' lock wait');
}
integration('T008 protected private orientation storage', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
  });
  afterAll(async () => {
    await Promise.all([db.$disconnect(), locker.$disconnect(), observer.$disconnect()]);
  });
  it('has additive private projection/version tables and restrictive references', async () => {
    const rows = await db.$queryRawUnsafe<{ name: string }[]>(
      `SELECT tablename AS name FROM pg_tables WHERE schemaname='public' AND tablename IN ('RaiderPreferences','RaiderPreferenceVersion') ORDER BY tablename`,
    );
    expect(rows.map((r) => r.name)).toEqual(['RaiderPreferenceVersion', 'RaiderPreferences']);
  });
  it('creates a private recorded version for its own wallet session without granting skill or capacity', async () => {
    const a = await actor();
    expect(await read(a)).toBeNull();
    const result = await save(a);
    expect(result).toMatchObject({
      status: 'EXECUTED',
      orientation: {
        version: 'v1',
        state: 'RECORDED',
        revision: 1,
        preferences: {
          ...preferences,
          workInterests: ['frontend', 'qa'],
          portfolioUrl: null,
          evidencePath: null,
        },
      },
    });
    expect(Number.isFinite(Date.parse(result.orientation.recordedAt))).toBe(true);
    expect(Object.keys(result.orientation).sort()).toEqual([
      'preferences',
      'recordedAt',
      'revision',
      'state',
      'version',
    ]);
    expect(await read(a)).toEqual(result.orientation);
    expect(await counts()).toEqual({
      versions: 1,
      profiles: 1,
      participants: 1,
      receipts: 1,
      audits: 1,
      outbox: 0,
    });
    const audit = await db.auditEvent.findFirstOrThrow();
    expect(audit).toMatchObject({
      eventType: 'identity.onboarding_recorded.v1',
      aggregateId: a.accountId,
      aggregateVersion: 1,
      actorId: a.accountId,
      payload: { orientationVersionId: expect.any(String) },
    });
    expect(JSON.stringify(audit)).not.toContain('Asia/Kathmandu');
  });
  it('reuses an existing HUMAN, leaves payout and prior history unchanged and hides foreign preferences', async () => {
    const a = await actor('x');
    const other = await actor();
    const participant = await db.$transaction((tx) =>
      ensureHumanParticipant(createPrismaIdentityTransaction(tx), {
        accountId: a.accountId,
        actorAccountId: a.accountId,
        requestId: 'existing-human',
      }),
    );
    const wallet = await db.walletIdentity.create({
      data: { userId: a.accountId, address: 'synthetic-preserved-payout' },
    });
    const before = await db.user.findUniqueOrThrow({ where: { id: a.accountId } });
    await save(a);
    expect(await read(other)).toBeNull();
    expect(await db.user.findUniqueOrThrow({ where: { id: a.accountId } })).toEqual(before);
    expect(await db.walletIdentity.findUnique({ where: { userId: a.accountId } })).toEqual(wallet);
    expect(await db.participant.findUnique({ where: { accountId: a.accountId } })).toMatchObject(
      participant,
    );
    expect(await db.participant.count()).toBe(1);
  });
  it('replays the immutable original response after later updates and rejects changed bodies', async () => {
    const a = await actor();
    const first = await save(a);
    const second = await save(a, body(1, { timezone: 'UTC' }), 'orientation-2');
    expect(second.orientation.revision).toBe(2);
    expect(await save(a)).toEqual({ ...first, status: 'REPLAYED' });
    expect(await read(a)).toEqual(second.orientation);
    await expect(save(a, body(0, { timezone: 'UTC' }))).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(await counts()).toEqual({
      versions: 2,
      profiles: 1,
      participants: 1,
      receipts: 2,
      audits: 2,
      outbox: 0,
    });
  });
  it('replays its original version after host catalog retirement while new unsupported interests fail closed', async () => {
    const a = await actor();
    const first = await save(a);
    const retiredHost = { ...host, interestIds: ['qa'] };
    const invoke = (key: string) =>
      runCommandTransaction(db, (tx) =>
        saveRaiderOrientation(
          tx,
          { actor: a, input: body(), idempotencyKey: key, requestId: 'retired-request' },
          retiredHost,
        ),
      );
    expect(await invoke('orientation-1')).toEqual({ ...first, status: 'REPLAYED' });
    await expect(invoke('retired-new')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await counts()).toEqual({
      versions: 1,
      profiles: 1,
      participants: 1,
      receipts: 1,
      audits: 1,
      outbox: 0,
    });
  });
  it('blocks new writes but preserves original replay when the host disables creation', async () => {
    const a = await actor();
    const first = await save(a);
    const disabled = (key: string) =>
      runCommandTransaction(db, (tx) =>
        saveRaiderOrientation(
          tx,
          {
            actor: a,
            input: key === 'orientation-1' ? body() : body(1),
            idempotencyKey: key,
            requestId: 'disabled-request',
          },
          host,
          { allowNewWrites: false },
        ),
      );
    expect(await disabled('orientation-1')).toEqual({ ...first, status: 'REPLAYED' });
    await expect(disabled('disabled-new')).rejects.toMatchObject({ code: 'WRITES_DISABLED' });
    expect(await counts()).toEqual({
      versions: 1,
      profiles: 1,
      participants: 1,
      receipts: 1,
      audits: 1,
      outbox: 0,
    });
  });
  it('serializes duplicate receipts and same-revision competing writes without partial effects', async () => {
    const a = await actor();
    const results = await Promise.all([save(a), save(a)]);
    expect(results.map((r) => r.status).sort()).toEqual(['EXECUTED', 'REPLAYED']);
    expect(results[0].orientation).toEqual(results[1].orientation);
    const attempts = await Promise.allSettled([
      save(a, body(1, { timezone: 'UTC' }), 'race-a'),
      save(a, body(1, { timezone: 'Europe/London' }), 'race-b'),
    ]);
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'REVISION_CONFLICT' },
    });
    expect(await counts()).toEqual({
      versions: 2,
      profiles: 1,
      participants: 1,
      receipts: 2,
      audits: 2,
      outbox: 0,
    });
  });
  it('rolls back a failed transaction and retries the whole original command identity', async () => {
    const a = await actor();
    let attempts = 0;
    const result = await runCommandTransaction(db, async (tx) => {
      const r = await saveRaiderOrientation(
        tx,
        { actor: a, input: body(), idempotencyKey: 'retry', requestId: 'request-retry' },
        host,
      );
      if (++attempts === 1) throw new CommandReceiptError('RETRY_TRANSACTION');
      return r;
    });
    expect(attempts).toBe(2);
    expect(result.orientation.revision).toBe(1);
    expect(await counts()).toEqual({
      versions: 1,
      profiles: 1,
      participants: 1,
      receipts: 1,
      audits: 1,
      outbox: 0,
    });
  });
  it.each(['actorAccountId', 'accountId', 'sessionHash'] as const)(
    'rejects substituted %s and foreign authority without any mutation',
    async (field) => {
      const a = await actor();
      const b = await actor();
      const forged = { ...a, [field]: b[field] };
      await expect(save(forged)).rejects.toMatchObject({
        code: field === 'sessionHash' ? 'UNAUTHENTICATED' : 'WRONG_ACTOR',
      });
      expect(await counts()).toEqual({
        versions: 0,
        profiles: 0,
        participants: 0,
        receipts: 0,
        audits: 0,
        outbox: 0,
      });
    },
  );
  it.each(['rank', 'accountId', 'sessionHash', 'verified', 'reservesCapacity'])(
    'rejects injected preference authority %s',
    async (field) => {
      const a = await actor();
      await expect(save(a, body(0, { [field]: 'forged' }))).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      expect(await counts()).toEqual({
        versions: 0,
        profiles: 0,
        participants: 0,
        receipts: 0,
        audits: 0,
        outbox: 0,
      });
    },
  );
  it('rejects suspended and expired authority including reads and receipt replay', async () => {
    const a = await actor();
    await save(a);
    await db.session.update({
      where: { tokenHash: a.sessionHash },
      data: { expiresAt: new Date(0) },
    });
    await expect(save(a)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(read(a)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await db.session.update({
      where: { tokenHash: a.sessionHash },
      data: { expiresAt: new Date(Date.now() + 60000) },
    });
    await db.user.update({ where: { id: a.accountId }, data: { suspended: true } });
    await expect(save(a)).rejects.toMatchObject({ code: 'ACCOUNT_RESTRICTED' });
    await expect(read(a)).rejects.toMatchObject({ code: 'ACCOUNT_RESTRICTED' });
    expect(await counts()).toEqual({
      versions: 1,
      profiles: 1,
      participants: 1,
      receipts: 1,
      audits: 1,
      outbox: 0,
    });
  });
  it.each(['expire', 'revoke', 'suspend'] as const)(
    'rechecks %s committed during an observed account lock wait',
    async (change) => {
      const a = await actor();
      const h = await hold(a);
      const pending = save(a).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      try {
        await blocked(h.pid, 'FOR NO KEY UPDATE');
        if (change === 'expire')
          await observer.session.update({
            where: { tokenHash: a.sessionHash },
            data: { expiresAt: new Date(0) },
          });
        if (change === 'revoke')
          await observer.session.delete({ where: { tokenHash: a.sessionHash } });
        // The account holder owns suspension; commit before the waiting command continues.
        if (change === 'suspend')
          await h.mutate('UPDATE \"User\" SET suspended=true WHERE id=$1', a.accountId);
      } finally {
        h.release();
        await h.held;
      }
      expect(await pending).toMatchObject({
        error: { code: change === 'suspend' ? 'ACCOUNT_RESTRICTED' : 'UNAUTHENTICATED' },
      });
      expect(await counts()).toEqual({
        versions: 0,
        profiles: 0,
        participants: 0,
        receipts: 0,
        audits: 0,
        outbox: 0,
      });
    },
    15000,
  );
  it('checks the database clock after the real Session lock wait rather than transaction start', async () => {
    const a = await actor();
    const h = await hold(a, true);
    const pending = save(a).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      await blocked(h.pid, 'FOR SHARE');
      await h.mutate(
        `UPDATE \"Session\" SET \"expiresAt\"=clock_timestamp()+interval '120 milliseconds' WHERE \"tokenHash\"=$1`,
        a.sessionHash,
      );
      await observer.$queryRawUnsafe('SELECT 1 FROM pg_sleep(0.2)');
    } finally {
      h.release();
      await h.held;
    }
    expect(await pending).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    expect(await counts()).toEqual({
      versions: 0,
      profiles: 0,
      participants: 0,
      receipts: 0,
      audits: 0,
      outbox: 0,
    });
  }, 15000);
  it('rejects unaudited versions, foreign participant provenance and injected stored privilege fields at commit', async () => {
    const a = await actor();
    const b = await actor();
    await save(a);
    await save(b, body(), 'guard-other');
    const [own] = await db.$queryRawUnsafe<
      { id: string; participantId: string; preferences: unknown }[]
    >(
      'SELECT "id"::text,"participantId"::text,"preferences" FROM "RaiderPreferenceVersion" WHERE "accountId"=$1',
      a.accountId,
    );
    const foreign = await db.participant.findUniqueOrThrow({ where: { accountId: b.accountId } });
    const before = await counts();
    const attempt = (mode: string) =>
      db.$transaction(async (tx) => {
        const versionId = randomUUID();
        const receiptId = randomUUID();
        await tx.$executeRawUnsafe(
          `INSERT INTO "CommandReceipt" ("id","actorId","commandKind","idempotencyKey","requestDigest","requestId","resultRef") VALUES ($1::uuid,$2,'SaveRaiderOrientation',$3,$4,'direct-fixture',$5)`,
          receiptId,
          a.accountId,
          'direct-' + mode,
          'a'.repeat(64),
          versionId,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "RaiderPreferenceVersion" ("id","accountId","participantId","revision","preferences","receiptId","actorAccountId","requestId") VALUES ($1::uuid,$2,$3::uuid,2,$4::jsonb,$5::uuid,$6,'direct-fixture')`,
          versionId,
          a.accountId,
          mode === 'foreign-participant' ? foreign.id : own.participantId,
          JSON.stringify(
            mode === 'rank' ? { ...(own.preferences as object), rank: 'S' } : own.preferences,
          ),
          receiptId,
          mode === 'foreign-actor' ? b.accountId : a.accountId,
        );
        await tx.$executeRawUnsafe(
          'UPDATE "RaiderPreferences" SET revision=2,"currentVersionId"=$2::uuid WHERE "accountId"=$1',
          a.accountId,
          versionId,
        );
      });
    for (const [mode, pattern] of [
      ['unaudited', /private audit/i],
      ['foreign-participant', /foreign key/i],
      ['foreign-actor', /actor_check/i],
      ['rank', /preferences_check/i],
    ] as const) {
      await expect(attempt(mode)).rejects.toThrow(pattern);
      expect(await counts()).toEqual(before);
    }
  });
  it('accepts valid uppercase HTTP(S) portfolio schemes consistently with the published input contract', async () => {
    const a = await actor();
    const result = await save(
      a,
      body(0, { experience: 'EXPERIENCED', portfolioUrl: 'HTTPS://portfolio.example/synthetic' }),
    );
    expect(result.orientation.preferences.portfolioUrl).toBe('HTTPS://portfolio.example/synthetic');
    expect(await read(a)).toEqual(result.orientation);
  });
  it('guards immutable versions, provenance, revision pointers and unaudited direct changes', async () => {
    const a = await actor();
    await save(a);
    const b = await actor();
    await save(b, body(), 'other');
    const rows = await db.$queryRawUnsafe<{ id: string; accountId: string }[]>(
      'SELECT "id"::text,"accountId" FROM "RaiderPreferenceVersion"',
    );
    const own = rows.find((r) => r.accountId === a.accountId)!;
    const foreign = rows.find((r) => r.accountId === b.accountId)!;
    const rejects = async (sql: string, values: string[], pattern: RegExp) => {
      await expect(db.$executeRawUnsafe(sql, ...values)).rejects.toThrow(pattern);
    };
    await rejects(
      `UPDATE "RaiderPreferenceVersion" SET preferences=preferences || '{"timezone":"UTC"}'::jsonb WHERE id=$1::uuid`,
      [own.id],
      /immutable/i,
    );
    await rejects(
      'DELETE FROM "RaiderPreferenceVersion" WHERE id=$1::uuid',
      [own.id],
      /retention|immutable/i,
    );
    await rejects(
      'UPDATE "RaiderPreferences" SET "currentVersionId"=$2::uuid WHERE "accountId"=$1',
      [a.accountId, foreign.id],
      /revision|foreign key/i,
    );
    await rejects(
      'UPDATE "RaiderPreferences" SET "accountId"=$2 WHERE "accountId"=$1',
      [a.accountId, b.accountId],
      /immutable/i,
    );
    await rejects(
      'UPDATE "RaiderPreferences" SET revision=revision+1 WHERE "accountId"=$1',
      [a.accountId],
      /foreign key|version/i,
    );
    await rejects(
      'DELETE FROM "RaiderPreferences" WHERE "accountId"=$1',
      [a.accountId],
      /retention|immutable/i,
    );
  });
});
