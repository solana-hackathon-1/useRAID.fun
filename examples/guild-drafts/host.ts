import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { pool } from './connection';
import {
  retryWholeTransaction,
  CommandReceiptError,
  type CommandReceiptTransaction,
} from './command-receipts';
import {
  saveGuildDraft,
  readGuildDraft,
  GuildDraftStorageError,
  type GuildDraftActor,
} from './guild-profiles/draft-storage';
const id = 'synthetic-draft-host-' + randomUUID();
const tokenHash = createHash('sha256')
  .update('synthetic-cookie-' + id)
  .digest('hex');
const actor: GuildDraftActor = { accountId: id, actorAccountId: id, sessionHash: tokenHash };
const profile = {
  name: 'Synthetic Guild',
  slug: 'synthetic-' + randomUUID(),
  description: 'Private preparation',
};
async function transaction<T>(work: (tx: CommandReceiptTransaction) => Promise<T>): Promise<T> {
  return retryWholeTransaction(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const { rows } = await client.query<{ transaction_isolation: string }>(
        'SHOW transaction_isolation',
      );
      assert.equal(rows[0].transaction_isolation, 'read committed');
      const port: CommandReceiptTransaction = {
        dialect: 'POSTGRESQL',
        isolation: 'READ_COMMITTED',
        async query<Row>(sql: string, bindings: readonly (string | null)[]) {
          try {
            return (await client.query<Row>(sql, bindings)).rows;
          } catch (error) {
            const state = (error as { code?: string }).code;
            throw new CommandReceiptError(
              state === '40001' || state === '40P01' ? 'RETRY_TRANSACTION' : 'STORAGE_UNAVAILABLE',
            );
          }
        },
      };
      const result = await work(port);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
}
const save = (guildDraftId: string | null, expectedRevision: number, key: string, extra = {}) =>
  transaction((tx) =>
    saveGuildDraft(
      tx,
      {
        actor,
        input: { guildDraftId, expectedRevision, profile: { ...profile, ...extra } },
        idempotencyKey: key,
        requestId: 'request-' + key,
      },
      { allowNewWrites: true },
    ),
  );
try {
  const client = await pool.connect();
  try {
    await client.query('INSERT INTO "User" (id) VALUES ($1)', [id]);
    await client.query(
      `INSERT INTO "Session" ("tokenHash","userId","expiresAt") VALUES ($1,$2,(clock_timestamp() AT TIME ZONE 'UTC')+interval '1 hour')`,
      [tokenHash, id],
    );
  } finally {
    client.release();
  }
  const first = await save(null, 0, 'first-' + id);
  assert.equal(first.draft.state, 'DRAFT_UNVERIFIED');
  assert.equal(first.draft.founderControlVerified, false);
  assert.equal(first.draft.publicProfileApproved, false);
  assert.equal(first.draft.primaryToken, null);
  const updated = await save(first.draft.id, 1, 'second-' + id, { name: 'Updated' });
  assert.equal(updated.draft.revision, 2);
  assert.deepEqual(await save(null, 0, 'first-' + id), { ...first, status: 'REPLAYED' });
  assert.deepEqual(
    await transaction((tx) => readGuildDraft(tx, actor, first.draft.id)),
    updated.draft,
  );
  await assert.rejects(
    save(null, 0, 'first-' + id, { description: 'Changed' }),
    (e) => e instanceof CommandReceiptError && e.code === 'IDEMPOTENCY_KEY_REUSED',
  );
  await assert.rejects(
    transaction((tx) =>
      readGuildDraft(tx, { ...actor, sessionHash: 'b'.repeat(64) }, first.draft.id),
    ),
    (e) => e instanceof GuildDraftStorageError && e.code === 'UNAUTHENTICATED',
  );
  let attempts = 0;
  const retried = await retryWholeTransaction(() =>
    transaction(async (tx) => {
      const result = await saveGuildDraft(
        tx,
        {
          actor,
          input: { guildDraftId: first.draft.id, expectedRevision: 2, profile },
          idempotencyKey: 'retry-' + id,
          requestId: 'request-retry',
        },
        { allowNewWrites: true },
      );
      if (++attempts === 1) throw new CommandReceiptError('RETRY_TRANSACTION');
      return result;
    }),
  );
  assert.equal(attempts, 2);
  assert.equal(retried.draft.revision, 3);
  const check = await pool.connect();
  try {
    const {
      rows: [row],
    } = await check.query(
      `SELECT (SELECT count(*)::int FROM "GuildDraftVersion" WHERE "ownerAccountId"=$1) AS versions,(SELECT count(*)::int FROM "GuildDraft" WHERE "ownerAccountId"=$1) AS drafts,(SELECT count(*)::int FROM "AuditEvent" WHERE "actorId"=$1) AS audits,(SELECT count(*)::int FROM "OutboxEvent" o JOIN "AuditEvent" a ON a.id=o."eventId" WHERE a."actorId"=$1) AS outbox`,
      [id],
    );
    assert.deepEqual(row, { versions: 3, drafts: 1, audits: 3, outbox: 0 });
  } finally {
    check.release();
  }
  console.log(
    JSON.stringify({
      synthetic: true,
      realDatabase: true,
      ownSchema: true,
      alternatePgPort: true,
      privateRead: true,
      originalReplay: true,
      changedBodyConflict: true,
      foreignSessionDenied: true,
      wholeRetry: true,
      noProjectAuthorityOrOutbox: true,
    }),
  );
} finally {
  await pool.end();
}
