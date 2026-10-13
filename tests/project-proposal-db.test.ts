import { randomUUID } from 'node:crypto';
import bs58 from 'bs58';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { executeIdempotentCommand, CommandReceiptError } from '../src/command-receipts';
import { db } from '../src/lib/db';
import { hash } from '../src/lib/auth-primitives';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import {
  saveGuildDraft,
  readGuildDraft,
  type GuildDraftActor,
} from '../src/guild-profiles/draft-storage';
import {
  saveGuildProjectProposal,
  readGuildProjectProposal,
} from '../src/guild-profiles/project-proposal-storage';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const candidateToken = {
  chain: 'SOLANA',
  networkIdentity: 'synthetic-genesis',
  kind: 'TOKEN',
  mint: bs58.encode(new Uint8Array(32).fill(17)),
  tokenProgram: bs58.encode(new Uint8Array(32).fill(18)),
};
const references = ['https://public.example/project'];
let seq = 0;
async function owner() {
  const user = await db.user.create({ data: { handle: 'synthetic-proposal-' + ++seq } });
  const sessionHash = hash(user.id);
  await db.session.create({
    data: {
      userId: user.id,
      tokenHash: sessionHash,
      via: 'wallet',
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  return { accountId: user.id, actorAccountId: user.id, sessionHash };
}
const draft = (actor: GuildDraftActor) =>
  runCommandTransaction(db, (tx) =>
    saveGuildDraft(
      tx,
      {
        actor,
        idempotencyKey: 'draft-' + seq,
        requestId: 'draft-' + seq,
        input: {
          guildDraftId: null,
          expectedRevision: 0,
          profile: {
            name: 'Synthetic proposal',
            slug: 'synthetic-proposal-' + seq,
            description: 'Private preparation',
          },
        },
      },
      { allowNewWrites: true },
    ),
  );
const body = (guildDraftId: string, expectedProposalRevision = 0, extra = {}) => ({
  guildDraftId,
  expectedDraftRevision: 1,
  expectedProposalRevision,
  candidateToken,
  publicEvidenceRefs: references,
  ...extra,
});
const save = (actor: GuildDraftActor, input: unknown, key = 'proposal-1', allowNewWrites = true) =>
  runCommandTransaction(db, (tx) =>
    saveGuildProjectProposal(
      tx,
      { actor, input, idempotencyKey: key, requestId: 'request-' + key },
      { allowNewWrites },
    ),
  );
const read = (actor: GuildDraftActor, id: string) =>
  runCommandTransaction(db, (tx) => readGuildProjectProposal(tx, actor, id));
async function counts() {
  const [row] = await db.$queryRawUnsafe<Record<string, number>[]>(
    `SELECT (SELECT count(*)::int FROM "GuildProjectProposal") AS proposals,(SELECT count(*)::int FROM "GuildProjectProposalVersion") AS versions,(SELECT count(*)::int FROM "CommandReceipt") AS receipts,(SELECT count(*)::int FROM "AuditEvent") AS audits,(SELECT count(*)::int FROM "OutboxEvent") AS outbox`,
  );
  return row;
}
integration('T010B private pending existing-project proposal storage', () => {
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
  async function hold(
    a: GuildDraftActor,
    id: string,
    table: 'User' | 'Session' | 'GuildDraft' | 'GuildProjectProposal',
  ) {
    let ready!: (pid: number) => void, release!: () => void, heldTx!: Prisma.TransactionClient;
    const started = new Promise<number>((r) => (ready = r)),
      gate = new Promise<void>((r) => (release = r));
    const held = locker.$transaction(async (tx) => {
      const [row] = await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
      if (table === 'User')
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "User" WHERE "id"=$1 FOR NO KEY UPDATE',
          a.accountId,
        );
      else if (table === 'Session')
        await tx.$queryRawUnsafe(
          'SELECT "tokenHash" FROM "Session" WHERE "tokenHash"=$1 FOR UPDATE',
          a.sessionHash,
        );
      else if (table === 'GuildDraft')
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "GuildDraft" WHERE "id"=$1::uuid FOR UPDATE',
          id,
        );
      else
        await tx.$queryRawUnsafe(
          'SELECT "guildDraftId" FROM "GuildProjectProposal" WHERE "guildDraftId"=$1::uuid FOR UPDATE',
          id,
        );
      heldTx = tx;
      ready(row.pid);
      await gate;
    });
    return {
      pid: await Promise.race([
        started,
        held.then(() => {
          throw Error('Lock holder ended before ready');
        }),
      ]),
      release,
      held,
      mutate: (sql: string, ...bindings: string[]) => heldTx.$executeRawUnsafe(sql, ...bindings),
    };
  }
  async function waitBlocked(pid: number, statement: RegExp) {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const rows = await observer.$queryRawUnsafe<{ query: string }[]>(
        'SELECT query FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))',
        pid,
      );
      if (rows.some((row) => statement.test(row.query))) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw Error('No actual proposal lock wait observed');
  }
  async function insertVersion(
    tx: Prisma.TransactionClient,
    receiptId: string,
    id: string,
    patch: {
      ownerAccountId?: string;
      draftVersionId?: string;
      candidateToken?: unknown;
      publicEvidenceRefs?: unknown;
    } = {},
  ) {
    const [row] = await tx.$queryRawUnsafe<
      { ownerAccountId: string; draftVersionId: string; draftRevision: number; revision: number }[]
    >(
      'SELECT "ownerAccountId","draftVersionId"::text,"draftRevision","revision" FROM "GuildProjectProposalVersion" WHERE "guildDraftId"=$1::uuid ORDER BY "revision" DESC LIMIT 1',
      id,
    );
    const ownerId = patch.ownerAccountId ?? row.ownerAccountId;
    return tx.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO "GuildProjectProposalVersion"("guildDraftId","ownerAccountId","revision","draftVersionId","draftRevision","candidateToken","publicEvidenceRefs","receiptId","actorAccountId","requestId") VALUES($1::uuid,$2,$3::int,$4::uuid,$5::int,$6::jsonb,$7::jsonb,$8::uuid,$2,'sql-probe') RETURNING "id"::text`,
      id,
      ownerId,
      row.revision + 1,
      patch.draftVersionId ?? row.draftVersionId,
      row.draftRevision,
      JSON.stringify(patch.candidateToken ?? candidateToken),
      JSON.stringify(patch.publicEvidenceRefs ?? references),
      receiptId,
    );
  }
  const directInsert = (
    a: GuildDraftActor,
    id: string,
    patch: Parameters<typeof insertVersion>[3] = {},
    wrongAudit = false,
  ) =>
    db.$transaction(async (tx) =>
      executeIdempotentCommand(
        {
          dialect: 'POSTGRESQL',
          isolation: 'READ_COMMITTED',
          query: <Row>(sql: string, bindings: readonly (string | null)[]) =>
            tx.$queryRawUnsafe<Row[]>(sql, ...bindings),
        },
        {
          actorId: a.accountId,
          commandKind: 'SaveGuildProjectProposal',
          idempotencyKey: 'sql-' + randomUUID(),
          requestId: 'sql-probe',
          request: {},
        },
        async ({ receiptId }) => {
          const rows = await insertVersion(tx, receiptId, id, patch);
          const version = rows[0].id;
          await tx.$executeRawUnsafe(
            'UPDATE "GuildProjectProposal" SET "revision"="revision"+1,"currentVersionId"=$1::uuid WHERE "guildDraftId"=$2::uuid',
            version,
            id,
          );
          return {
            resultRef: version,
            events: [
              {
                type: wrongAudit ? 'guild.draft_recorded.v1' : 'guild.project_proposal_recorded.v1',
                aggregateId: id,
                aggregateVersion: 2,
                payload: { projectProposalVersionId: version },
                publish: false,
              },
            ],
          };
        },
      ),
    );
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
  });
  afterAll(async () => {
    await Promise.all([db.$disconnect(), locker?.$disconnect(), observer?.$disconnect()]);
  });
  it('persists an owner-attributed pending exact-asset proposal without recognizing a Guild or granting authority', async () => {
    const a = await owner(),
      d = await draft(a),
      input = body(d.draft.id);
    const r = await save(a, input);
    expect(r.status).toBe('EXECUTED');
    expect(r.proposal).toMatchObject({
      version: 'v1',
      guildDraftId: d.draft.id,
      revision: 1,
      draftRevision: 1,
      projectType: 'EXISTING_PROJECT',
      state: 'PENDING_VERIFICATION',
      persisted: true,
      candidateToken,
      publicEvidenceRefs: references,
      founderControlVerified: false,
      recognizesGuild: false,
      activatesToken: false,
      createsPermissionGrant: false,
      publicProfileApproved: false,
    });
    expect(await read(a, d.draft.id)).toEqual(r.proposal);
    expect(await counts()).toEqual({
      proposals: 1,
      versions: 1,
      receipts: 2,
      audits: 2,
      outbox: 0,
    });
    const profile = await runCommandTransaction(db, (tx) => readGuildDraft(tx, a, d.draft.id));
    expect(profile.primaryToken).toBeNull();
    expect(JSON.stringify(r.proposal)).not.toContain(a.accountId);
    expect(JSON.stringify(r.proposal)).not.toContain(a.sessionHash);
  });
  it('reads null only for an authenticated own draft that has no proposal', async () => {
    const a = await owner(),
      d = await draft(a);
    expect(await read(a, d.draft.id)).toBeNull();
  });
  it('returns original immutable proposal after edits and preserves old candidate/evidence history', async () => {
    const a = await owner(),
      d = await draft(a),
      input = body(d.draft.id);
    const first = await save(a, input);
    const changed = body(d.draft.id, 1, {
      candidateToken: { ...candidateToken, mint: bs58.encode(new Uint8Array(32).fill(19)) },
      publicEvidenceRefs: ['https://public.example/new'],
    });
    const second = await save(a, changed, 'proposal-2');
    expect(second.proposal.revision).toBe(2);
    expect(await read(a, d.draft.id)).toEqual(second.proposal);
    expect(await save(a, input, 'proposal-1', false)).toEqual({
      status: 'REPLAYED',
      proposal: first.proposal,
    });
    expect(await counts()).toEqual({
      proposals: 1,
      versions: 2,
      receipts: 3,
      audits: 3,
      outbox: 0,
    });
  });
  it('rejects changed-body key reuse and stale proposal revision with no partial effects', async () => {
    const a = await owner(),
      d = await draft(a),
      input = body(d.draft.id);
    await save(a, input);
    const before = await counts();
    await expect(
      save(a, { ...input, publicEvidenceRefs: ['https://public.example/changed'] }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(save(a, input, 'new-stale-key')).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    expect(await counts()).toEqual(before);
  });
  it('checks expected current draft revision while original proposal receipts remain replayable', async () => {
    const a = await owner(),
      d = await draft(a),
      input = body(d.draft.id);
    const original = await save(a, input);
    await runCommandTransaction(db, (tx) =>
      saveGuildDraft(
        tx,
        {
          actor: a,
          input: {
            guildDraftId: d.draft.id,
            expectedRevision: 1,
            profile: { ...d.draft.profile, description: 'Edited profile' },
          },
          idempotencyKey: 'draft-update',
          requestId: 'draft-update',
        },
        { allowNewWrites: true },
      ),
    );
    await expect(save(a, body(d.draft.id, 1), 'stale-draft')).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    expect(await save(a, input)).toEqual({ status: 'REPLAYED', proposal: original.proposal });
    const current = await save(
      a,
      body(d.draft.id, 1, { expectedDraftRevision: 2 }),
      'current-draft',
    );
    expect(current.proposal.draftRevision).toBe(2);
  });
  it('denies unknown/foreign draft reads and writes identically without leaking another proposal', async () => {
    const a = await owner(),
      d = await draft(a);
    await save(a, body(d.draft.id));
    const b = await owner(),
      before = await counts();
    for (const id of [d.draft.id, randomUUID()]) {
      await expect(read(b, id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(save(b, body(id))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    expect(await counts()).toEqual(before);
  });
  it('requires current cookie session on read, write and receipt replay', async () => {
    const a = await owner(),
      d = await draft(a),
      input = body(d.draft.id);
    await save(a, input);
    await db.session.update({
      where: { tokenHash: a.sessionHash },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    await expect(read(a, d.draft.id)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(save(a, input)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(save(a, body(d.draft.id, 1), 'expired-new')).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });
  it('denies restricted/wrong actors and never uses global role or holder status', async () => {
    const a = await owner(),
      d = await draft(a);
    const before = await counts();
    await expect(
      save({ ...a, actorAccountId: 'wrong-actor' }, body(d.draft.id)),
    ).rejects.toMatchObject({ code: 'WRONG_ACTOR' });
    await db.user.update({ where: { id: a.accountId }, data: { suspended: true, role: 'ADMIN' } });
    await expect(save(a, body(d.draft.id))).rejects.toMatchObject({ code: 'ACCOUNT_RESTRICTED' });
    expect(await counts()).toEqual(before);
  });
  it('allows reads/original receipt replay with new writes disabled', async () => {
    const a = await owner(),
      d = await draft(a),
      input = body(d.draft.id);
    await expect(save(a, input, 'disabled', false)).rejects.toMatchObject({
      code: 'WRITES_DISABLED',
    });
    const first = await save(a, input);
    expect(await read(a, d.draft.id)).toEqual(first.proposal);
    expect(await save(a, input, 'proposal-1', false)).toEqual({
      status: 'REPLAYED',
      proposal: first.proposal,
    });
    await expect(save(a, body(d.draft.id, 1), 'disabled-update', false)).rejects.toMatchObject({
      code: 'WRITES_DISABLED',
    });
  });
  it('normalizes reference URLs and rejects credentials/duplicates/non-HTTPS/authority injection', async () => {
    const a = await owner(),
      d = await draft(a);
    for (const extra of [
      { publicEvidenceRefs: ['http://public.example'] },
      { publicEvidenceRefs: ['https://name:secret@public.example'] },
      { publicEvidenceRefs: [] },
      { publicEvidenceRefs: Array(6).fill('https://public.example') },
      { publicEvidenceRefs: ['https://public.example', 'https://public.example/'] },
      { founderControlVerified: true },
      { candidateToken: { ...candidateToken, symbol: 'TRUSTED' } },
    ])
      await expect(
        save(a, body(d.draft.id, 0, extra), 'bad-' + randomUUID()),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const r = await save(
      a,
      body(d.draft.id, 0, { publicEvidenceRefs: ['https://PUBLIC.EXAMPLE'] }),
    );
    expect(r.proposal.publicEvidenceRefs).toEqual(['https://public.example/']);
  });
  it('allows competing pending claims for the same exact token without falsely recognizing either project', async () => {
    const a = await owner(),
      da = await draft(a),
      b = await owner(),
      dbb = await draft(b);
    await save(a, body(da.draft.id));
    await save(b, body(dbb.draft.id));
    expect((await counts()).proposals).toBe(2);
  });
  it('serializes same-revision proposals to one winner and one exact revision conflict', async () => {
    const a = await owner(),
      d = await draft(a);
    const results = await Promise.allSettled([
      save(a, body(d.draft.id), 'race-a'),
      save(a, body(d.draft.id), 'race-b'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    for (const r of results)
      if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await counts()).toEqual({
      proposals: 1,
      versions: 1,
      receipts: 2,
      audits: 2,
      outbox: 0,
    });
  });
  it.each(['User', 'Session', 'GuildDraft', 'GuildProjectProposal'] as const)(
    'uses DB time after a real %s lock wait and rolls back expired writes',
    async (table) => {
      const a = await owner(),
        d = await draft(a);
      await save(a, body(d.draft.id));
      const before = await counts();
      const expiresAt = new Date(Date.now() + 600);
      await db.session.update({ where: { tokenHash: a.sessionHash }, data: { expiresAt } });
      const lock = await hold(a, d.draft.id, table);
      const pending = save(a, body(d.draft.id, 1), 'expiry-' + table).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      try {
        const statement =
          table === 'User'
            ? /FROM "User".*FOR NO KEY UPDATE/
            : table === 'Session'
              ? /FROM "Session".*FOR SHARE/
              : table === 'GuildDraft'
                ? /FROM "GuildDraft".*FOR SHARE/
                : /FROM "GuildProjectProposal".*FOR UPDATE/;
        await waitBlocked(lock.pid, statement);
        await new Promise((r) => setTimeout(r, Math.max(0, expiresAt.getTime() - Date.now() + 25)));
      } finally {
        lock.release();
        await lock.held;
      }
      expect(await pending).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
      expect(await counts()).toEqual(before);
    },
  );
  it('denies suspension committed while waiting on the own account row', async () => {
    const a = await owner(),
      d = await draft(a);
    await save(a, body(d.draft.id));
    const before = await counts();
    const lock = await hold(a, d.draft.id, 'User');
    const pending = save(a, body(d.draft.id, 1), 'restrict-after-wait').then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      await waitBlocked(lock.pid, /FROM "User".*FOR NO KEY UPDATE/);
      await lock.mutate('UPDATE "User" SET "suspended"=true WHERE "id"=$1', a.accountId);
    } finally {
      lock.release();
      await lock.held;
    }
    expect(await pending).toMatchObject({ error: { code: 'ACCOUNT_RESTRICTED' } });
    expect(await counts()).toEqual(before);
  });
  it('authenticates before disclosing changed-body receipt conflicts', async () => {
    const a = await owner(),
      d = await draft(a);
    await save(a, body(d.draft.id));
    await db.session.delete({ where: { tokenHash: a.sessionHash } });
    await expect(
      save(a, body(d.draft.id, 0, { publicEvidenceRefs: ['https://public.example/different'] })),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
  it('retries an entire aborted proposal transaction under the same command identity exactly once', async () => {
    const a = await owner(),
      d = await draft(a);
    let attempt = 0;
    const result = await runCommandTransaction(db, async (tx) => {
      const saved = await saveGuildProjectProposal(
        tx,
        { actor: a, input: body(d.draft.id), idempotencyKey: 'retry', requestId: 'retry' },
        { allowNewWrites: true },
      );
      if (++attempt === 1) throw new CommandReceiptError('RETRY_TRANSACTION');
      return saved;
    });
    expect(attempt).toBe(2);
    expect(result.status).toBe('EXECUTED');
    expect(await counts()).toEqual({
      proposals: 1,
      versions: 1,
      receipts: 2,
      audits: 2,
      outbox: 0,
    });
  });
  it('guards immutable versions, sequential projection and owner/draft identity in direct SQL', async () => {
    const a = await owner(),
      d = await draft(a);
    await save(a, body(d.draft.id));
    const before = await counts();
    for (const sql of [
      'UPDATE "GuildProjectProposalVersion" SET "revision"="revision"',
      'DELETE FROM "GuildProjectProposalVersion"',
      'DELETE FROM "GuildProjectProposal"',
      'UPDATE "GuildProjectProposal" SET "revision"="revision"+2',
      'UPDATE "GuildProjectProposal" SET "ownerAccountId"=\'foreign-owner\'',
    ])
      await expect(db.$executeRawUnsafe(sql)).rejects.toMatchObject({ meta: { code: '23000' } });
    expect(await counts()).toEqual(before);
  });
  it('requires structural candidate/reference contracts and exact owned draft snapshot in SQL', async () => {
    const a = await owner(),
      d = await draft(a);
    await save(a, body(d.draft.id));
    const b = await owner(),
      foreign = await draft(b);
    const [snapshot] = await db.$queryRawUnsafe<{ id: string }[]>(
      'SELECT "currentVersionId"::text AS id FROM "GuildDraft" WHERE "id"=$1::uuid',
      foreign.draft.id,
    );
    const before = await counts();
    for (const patch of [
      { candidateToken: { ...candidateToken, verified: true } },
      { candidateToken: { ...candidateToken, kind: 'NATIVE_SOL' } },
      { publicEvidenceRefs: [] },
      { publicEvidenceRefs: ['http://public.example'] },
      { publicEvidenceRefs: ['https://user:secret@public.example/'] },
      { publicEvidenceRefs: [references[0], references[0]] },
    ])
      await expect(directInsert(a, d.draft.id, patch)).rejects.toMatchObject({
        meta: { code: '23514' },
      });
    await expect(
      directInsert(a, d.draft.id, { draftVersionId: snapshot.id }),
    ).rejects.toMatchObject({ meta: { code: '23503' } });
    expect(await counts()).toEqual(before);
  });
  it('requires exact finalized owner receipt and private audit before committing a proposal version', async () => {
    const a = await owner(),
      d = await draft(a);
    await save(a, body(d.draft.id));
    const before = await counts();
    await expect(directInsert(a, d.draft.id, {}, true)).rejects.toThrow(
      'Project proposal requires its finalized owner receipt/private audit/projection',
    );
    expect(await counts()).toEqual(before);
  });
});
