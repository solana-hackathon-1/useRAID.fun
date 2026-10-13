import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { db } from '../src/lib/db';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { CommandReceiptError, executeIdempotentCommand } from '../src/command-receipts';
import {
  saveGuildDraft,
  readGuildDraft,
  type GuildDraftActor,
} from '../src/guild-profiles/draft-storage';
import { hash } from '../src/lib/auth-primitives';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const locker = new PrismaClient({ transactionOptions: { timeout: 15000 } });
const observer = new PrismaClient();
let counter = 0;
const profile = {
  name: 'Synthetic draft',
  slug: 'synthetic-draft',
  description: 'Synthetic owner description',
};
const body = (guildDraftId: string | null = null, expectedRevision = 0, extra = {}) => ({
  guildDraftId,
  expectedRevision,
  profile: { ...profile, ...extra },
});
async function actor(via = 'wallet'): Promise<GuildDraftActor> {
  const user = await db.user.create({ data: { handle: 'synthetic-guild-' + ++counter } });
  const sessionHash = hash(user.id);
  await db.session.create({
    data: { userId: user.id, tokenHash: sessionHash, via, expiresAt: new Date(Date.now() + 60000) },
  });
  return { accountId: user.id, actorAccountId: user.id, sessionHash };
}
const save = (
  a: GuildDraftActor,
  input: unknown = body(),
  key = 'draft-1',
  allowNewWrites = true,
) =>
  runCommandTransaction(db, (tx) =>
    saveGuildDraft(
      tx,
      { actor: a, input, idempotencyKey: key, requestId: 'request-' + key },
      { allowNewWrites },
    ),
  );
const read = (a: GuildDraftActor, id: string) =>
  runCommandTransaction(db, (tx) => readGuildDraft(tx, a, id));
async function counts() {
  const [row] = await db.$queryRawUnsafe<Record<string, number>[]>(
    `SELECT (SELECT count(*)::int FROM "GuildDraftVersion") AS versions,(SELECT count(*)::int FROM "GuildDraft") AS drafts,(SELECT count(*)::int FROM "CommandReceipt") AS receipts,(SELECT count(*)::int FROM "AuditEvent") AS audits,(SELECT count(*)::int FROM "OutboxEvent") AS outbox`,
  );
  return row;
}
async function hold(a: GuildDraftActor, table: 'User' | 'Session' | 'GuildDraft', id?: string) {
  let ready!: (pid: number) => void, release!: () => void, heldTx!: Prisma.TransactionClient;
  const started = new Promise<number>((r) => (ready = r)),
    gate = new Promise<void>((r) => (release = r));
  const held = locker.$transaction(async (tx) => {
    const [row] = await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
    if (table === 'Session')
      await tx.$queryRawUnsafe(
        'SELECT "tokenHash" FROM "Session" WHERE "tokenHash"=$1 FOR UPDATE',
        a.sessionHash,
      );
    else if (table === 'GuildDraft')
      await tx.$queryRawUnsafe('SELECT "id" FROM "GuildDraft" WHERE "id"=$1::uuid FOR UPDATE', id!);
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
      console.info(JSON.stringify({ guildDraftLock: { blocker: pid, waiter: waiter.pid, query } }));
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('No observed PostgreSQL draft lock wait: ' + query);
}
integration('T009B private own Guild draft storage', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
  });
  afterAll(async () => {
    await Promise.all([db.$disconnect(), locker.$disconnect(), observer.$disconnect()]);
  });
  it('has additive draft/version tables rather than assigning legacy creator privileges', async () => {
    const rows = await db.$queryRawUnsafe<{ name: string }[]>(
      `SELECT tablename AS name FROM pg_tables WHERE schemaname='public' AND tablename IN ('GuildDraft','GuildDraftVersion') ORDER BY tablename`,
    );
    expect(rows.map((r) => r.name)).toEqual(['GuildDraft', 'GuildDraftVersion']);
  });
  it('privately records an unverified owner draft with audit and leaves user/history/money unchanged', async () => {
    const a = await actor('x');
    const before = await db.user.findUniqueOrThrow({ where: { id: a.accountId } });
    const first = await save(a, body(null, 0, { name: ' Synthetic draft ' }));
    expect(first).toMatchObject({
      status: 'EXECUTED',
      draft: {
        version: 'v1',
        state: 'DRAFT_UNVERIFIED',
        revision: 1,
        founderControlVerified: false,
        publicProfileApproved: false,
        primaryToken: null,
        profile,
      },
    });
    expect(first.draft.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(Number.isFinite(Date.parse(first.draft.recordedAt))).toBe(true);
    expect(Object.keys(first.draft).sort()).toEqual([
      'founderControlVerified',
      'id',
      'primaryToken',
      'profile',
      'publicProfileApproved',
      'recordedAt',
      'revision',
      'state',
      'version',
    ]);
    expect(await read(a, first.draft.id)).toEqual(first.draft);
    expect(await db.user.findUniqueOrThrow({ where: { id: a.accountId } })).toEqual(before);
    expect(await db.participant.count()).toBe(0);
    expect(await db.usdcTransfer.count()).toBe(0);
    expect(await counts()).toEqual({ drafts: 1, versions: 1, receipts: 1, audits: 1, outbox: 0 });
    const event = await db.auditEvent.findFirstOrThrow();
    expect(event).toMatchObject({
      eventType: 'guild.draft_recorded.v1',
      actorId: a.accountId,
      guildId: null,
      aggregateId: first.draft.id,
      aggregateVersion: 1,
      payload: { guildDraftVersionId: expect.any(String) },
    });
    expect(JSON.stringify(event)).not.toContain(profile.description);
    expect(JSON.stringify(event)).not.toContain(profile.slug);
  });
  it('updates sequentially and replays the immutable original after later versions', async () => {
    const a = await actor();
    const first = await save(a);
    const second = await save(a, body(first.draft.id, 1, { name: 'Updated' }), 'draft-2');
    expect(second.draft.revision).toBe(2);
    expect(second.draft.profile.name).toBe('Updated');
    expect(await save(a)).toEqual({ ...first, status: 'REPLAYED' });
    expect(await read(a, first.draft.id)).toEqual(second.draft);
    await expect(save(a, body(null, 0, { description: 'Changed' }))).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(await counts()).toEqual({ drafts: 1, versions: 2, receipts: 2, audits: 2, outbox: 0 });
  });
  it('returns the same private absence for unknown and foreign draft reads/writes', async () => {
    const a = await actor(),
      other = await actor();
    const first = await save(a);
    for (const id of [first.draft.id, randomUUID()]) {
      await expect(read(other, id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(save(other, body(id, 1), 'foreign-' + id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    }
    expect(await counts()).toEqual({ drafts: 1, versions: 1, receipts: 1, audits: 1, outbox: 0 });
  });
  it('rejects injected authority/private fields and invalid creation/revision combinations', async () => {
    const a = await actor();
    for (const input of [
      { ...body(), founderAccountId: a.accountId },
      body(null, 1),
      body(randomUUID(), 0),
      body(null, 0, { privateNotes: 'hidden' }),
      body(null, 0, { primaryToken: null }),
      body(null, 0, { name: '   ' }),
    ])
      await expect(save(a, input)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await counts()).toEqual({ drafts: 0, versions: 0, receipts: 0, audits: 0, outbox: 0 });
  });
  it('rejects stale revisions and changing a stable persisted slug without partial receipts', async () => {
    const a = await actor(),
      first = await save(a);
    await expect(save(a, body(first.draft.id, 2), 'stale')).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    await expect(
      save(a, body(first.draft.id, 1, { slug: 'changed-slug' }), 'slug'),
    ).rejects.toMatchObject({ code: 'SLUG_IMMUTABLE' });
    expect(await counts()).toEqual({ drafts: 1, versions: 1, receipts: 1, audits: 1, outbox: 0 });
  });
  it('serializes duplicate commands to one draft/version/audit even when acknowledgment is lost', async () => {
    const a = await actor();
    const results = await Promise.all([save(a), save(a)]);
    expect(results.map((r) => r.status).sort()).toEqual(['EXECUTED', 'REPLAYED']);
    expect(results[0].draft).toEqual(results[1].draft);
    expect(await counts()).toEqual({ drafts: 1, versions: 1, receipts: 1, audits: 1, outbox: 0 });
  });
  it('serializes same-slug creation across accounts and rolls back the loser entirely', async () => {
    const a = await actor(),
      other = await actor();
    const results = await Promise.allSettled([save(a), save(other)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'SLUG_UNAVAILABLE' },
    });
    expect(await counts()).toEqual({ drafts: 1, versions: 1, receipts: 1, audits: 1, outbox: 0 });
  });
  it('allows only one concurrent update at an expected revision', async () => {
    const a = await actor(),
      first = await save(a);
    const results = await Promise.allSettled([
      save(a, body(first.draft.id, 1, { name: 'One' }), 'one'),
      save(a, body(first.draft.id, 1, { name: 'Two' }), 'two'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'REVISION_CONFLICT' },
    });
    expect(await counts()).toEqual({ drafts: 1, versions: 2, receipts: 2, audits: 2, outbox: 0 });
  });
  it('disables new writes while retaining owned reads and original authenticated replay', async () => {
    const a = await actor(),
      first = await save(a);
    expect(await save(a, body(), 'draft-1', false)).toEqual({ ...first, status: 'REPLAYED' });
    expect(await read(a, first.draft.id)).toEqual(first.draft);
    await expect(save(a, body(first.draft.id, 1), 'disabled', false)).rejects.toMatchObject({
      code: 'WRITES_DISABLED',
    });
  });
  it('requires the exact live current own wallet/X session for save/read/replay', async () => {
    const a = await actor(),
      other = await actor(),
      first = await save(a);
    for (const bad of [
      { ...a, sessionHash: other.sessionHash },
      { ...a, sessionHash: 'b'.repeat(64) },
      { ...a, actorAccountId: other.accountId },
    ]) {
      const code = bad.actorAccountId === a.accountId ? 'UNAUTHENTICATED' : 'WRONG_ACTOR';
      await expect(save(bad)).rejects.toMatchObject({ code });
      await expect(read(bad, first.draft.id)).rejects.toMatchObject({ code });
    }
    await db.session.delete({ where: { tokenHash: a.sessionHash } });
    await expect(save(a)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await counts()).toEqual({ drafts: 1, versions: 1, receipts: 1, audits: 1, outbox: 0 });
  });
  it('denies expired sessions, unsupported login methods and restricted owners', async () => {
    const a = await actor();
    await db.session.update({
      where: { tokenHash: a.sessionHash },
      data: { expiresAt: new Date(0) },
    });
    await expect(save(a)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const bad = await actor('unverified');
    await expect(save(bad)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const restricted = await actor();
    await db.user.update({ where: { id: restricted.accountId }, data: { suspended: true } });
    await expect(save(restricted)).rejects.toMatchObject({ code: 'ACCOUNT_RESTRICTED' });
    expect(await counts()).toEqual({ drafts: 0, versions: 0, receipts: 0, audits: 0, outbox: 0 });
  });
  it('checks session revocation after a real session lock wait', async () => {
    const a = await actor(),
      held = await hold(a, 'Session');
    const pending = save(a).then(
      (r) => ({ result: r }),
      (e) => ({ error: e }),
    );
    try {
      await blocked(held.pid, 'Session');
      await held.mutate('DELETE FROM "Session" WHERE "tokenHash"=$1', a.sessionHash);
    } finally {
      held.release();
      await held.held;
    }
    expect(await pending).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    expect(await counts()).toEqual({ drafts: 0, versions: 0, receipts: 0, audits: 0, outbox: 0 });
  });
  it('checks restriction after a real account lock wait', async () => {
    const a = await actor(),
      held = await hold(a, 'User');
    const pending = save(a).then(
      (r) => ({ result: r }),
      (e) => ({ error: e }),
    );
    try {
      await blocked(held.pid, 'User');
      await held.mutate('UPDATE "User" SET suspended=true WHERE id=$1', a.accountId);
    } finally {
      held.release();
      await held.held;
    }
    expect(await pending).toMatchObject({ error: { code: 'ACCOUNT_RESTRICTED' } });
  });
  it('checks expiry using the database clock after an actual draft row lock wait', async () => {
    const a = await actor(),
      first = await save(a);
    await db.$executeRawUnsafe(
      `UPDATE "Session" SET "expiresAt"=(clock_timestamp() AT TIME ZONE 'UTC')+interval '700 milliseconds' WHERE "tokenHash"=$1`,
      a.sessionHash,
    );
    const held = await hold(a, 'GuildDraft', first.draft.id),
      pending = save(a, body(first.draft.id, 1), 'after-lock').then(
        (r) => ({ result: r }),
        (e) => ({ error: e }),
      );
    try {
      await blocked(held.pid, 'GuildDraft');
      await locker.$queryRawUnsafe('SELECT pg_sleep(0.8)::text');
    } finally {
      held.release();
      await held.held;
    }
    expect(await pending).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    expect(await counts()).toEqual({ drafts: 1, versions: 1, receipts: 1, audits: 1, outbox: 0 });
  });
  it('retries the whole rolled-back command and commits exactly one next version', async () => {
    const a = await actor();
    let attempts = 0;
    const result = await runCommandTransaction(db, async (tx) => {
      const value = await saveGuildDraft(
        tx,
        { actor: a, input: body(), idempotencyKey: 'retry', requestId: 'request-retry' },
        { allowNewWrites: true },
      );
      if (++attempts === 1) throw new CommandReceiptError('RETRY_TRANSACTION');
      return value;
    });
    expect(attempts).toBe(2);
    expect(result.draft.revision).toBe(1);
    expect(await counts()).toEqual({ drafts: 1, versions: 1, receipts: 1, audits: 1, outbox: 0 });
  });
  it('keeps acknowledged versions immutable and denies direct owner/slug/revision rewrites', async () => {
    const a = await actor(),
      other = await actor(),
      first = await save(a);
    for (const sql of [
      `UPDATE "GuildDraftVersion" SET "profile"='{}'::jsonb`,
      `DELETE FROM "GuildDraftVersion"`,
      `UPDATE "GuildDraft" SET "ownerAccountId"='${other.accountId}'`,
      `UPDATE "GuildDraft" SET "slug"='replacement'`,
      `UPDATE "GuildDraft" SET "revision"=3`,
      `DELETE FROM "GuildDraft"`,
    ])
      await expect(db.$executeRawUnsafe(sql)).rejects.toMatchObject({
        code: 'P2010',
        meta: { code: '23000' },
      });
    expect(await read(a, first.draft.id)).toEqual(first.draft);
  });
  it('enforces structural public fields and forbids authority/private payload keys in SQL', async () => {
    for (const p of [
      { ...profile, name: ' ' },
      { ...profile, founderControlVerified: true },
      { ...profile, privateNotes: 'private' },
      { ...profile, slug: 'Not-Stable' },
      { ...profile, name: null },
      { ...profile, description: 'x'.repeat(4001) },
    ]) {
      const [row] = await db.$queryRawUnsafe<{ valid: boolean }[]>(
        'SELECT raid_guild_draft_profile_valid_v1($1::jsonb) IS TRUE AS valid',
        JSON.stringify(p),
      );
      expect(row.valid).toBe(false);
    }
    const [row] = await db.$queryRawUnsafe<{ valid: boolean }[]>(
      'SELECT raid_guild_draft_profile_valid_v1($1::jsonb) IS TRUE AS valid',
      JSON.stringify(profile),
    );
    expect(row.valid).toBe(true);
  });
  it('enforces owner/version/aggregate provenance with restrictive composite foreign keys', async () => {
    const a = await actor(),
      other = await actor(),
      first = await save(a);
    const [v] = await db.$queryRawUnsafe<{ id: string }[]>(
      'SELECT "id"::text FROM "GuildDraftVersion" WHERE "guildDraftId"=$1::uuid',
      first.draft.id,
    );
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "GuildDraft" (id,"ownerAccountId",slug,revision,"currentVersionId") VALUES ($1::uuid,$2,'foreign-pointer',1,$3::uuid)`,
        randomUUID(),
        other.accountId,
        v.id,
      ),
    ).rejects.toMatchObject({ code: 'P2010', meta: { code: '23503' } });
    await expect(db.user.delete({ where: { id: a.accountId } })).rejects.toBeDefined();
    expect(await counts()).toEqual({ drafts: 1, versions: 1, receipts: 1, audits: 1, outbox: 0 });
  });
  it('rejects a finalized receipt whose audit references a different draft', async () => {
    const a = await actor(),
      first = await save(a);
    await expect(
      runCommandTransaction(db, (tx) =>
        executeIdempotentCommand(
          tx,
          {
            actorId: a.accountId,
            commandKind: 'SaveGuildDraft',
            idempotencyKey: 'forged',
            requestId: 'request-forged',
            request: { synthetic: true },
          },
          async ({ receiptId }) => {
            const [v] = await tx.query<{ id: string }>(
              `INSERT INTO "GuildDraftVersion" ("guildDraftId","ownerAccountId",revision,profile,"receiptId","actorAccountId","requestId") VALUES ($1::uuid,$2,2,$3::jsonb,$4::uuid,$2,'request-forged') RETURNING id::text`,
              [first.draft.id, a.accountId, JSON.stringify(profile), receiptId],
            );
            await tx.query(
              'UPDATE "GuildDraft" SET revision=2,"currentVersionId"=$2::uuid WHERE id=$1::uuid RETURNING id',
              [first.draft.id, v.id],
            );
            return {
              resultRef: v.id,
              events: [
                {
                  type: 'guild.draft_recorded.v1',
                  aggregateId: randomUUID(),
                  aggregateVersion: 2,
                  payload: { guildDraftVersionId: v.id },
                  publish: false,
                },
              ],
            };
          },
        ),
      ),
    ).rejects.toThrow(
      'Guild draft version requires its finalized owner receipt/private audit/projection',
    );
    expect(await counts()).toEqual({ drafts: 1, versions: 1, receipts: 1, audits: 1, outbox: 0 });
  });
  it('denies replay after a real current-session lock wait and committed revocation', async () => {
    const a = await actor();
    await save(a);
    const held = await hold(a, 'Session'),
      pending = save(a).then(
        (r) => ({ result: r }),
        (e) => ({ error: e }),
      );
    try {
      await blocked(held.pid, 'Session');
      await held.mutate('DELETE FROM "Session" WHERE "tokenHash"=$1', a.sessionHash);
    } finally {
      held.release();
      await held.held;
    }
    expect(await pending).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    expect(await counts()).toEqual({ drafts: 1, versions: 1, receipts: 1, audits: 1, outbox: 0 });
  });
});
