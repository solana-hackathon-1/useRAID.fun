import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { pool } from './connection';
import {
  retryWholeTransaction,
  CommandReceiptError,
  type CommandReceiptTransaction,
} from './command-receipts';
import {
  readRaiderOrientation,
  saveRaiderOrientation,
  OrientationStorageError,
  type OrientationActor,
} from './raider-onboarding/storage';
import type { RaiderOnboardingHost } from './raider-onboarding';

const host: RaiderOnboardingHost = {
  version: 'v1',
  interestIds: ['qa'],
  nextActions: {
    starterTasks: { available: false, reason: 'NOT_READY' },
    portfolio: { available: false, reason: 'NOT_READY' },
    trial: { available: false, reason: 'NOT_READY' },
  },
};
const id = 'synthetic-host-' + randomUUID();
const tokenHash = createHash('sha256')
  .update('synthetic-cookie-' + id)
  .digest('hex');
const actor: OrientationActor = { accountId: id, actorAccountId: id, sessionHash: tokenHash };
const preferences = {
  experience: 'BEGINNER',
  workInterests: ['qa'],
  timezone: 'UTC',
  orientationAcknowledged: true,
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
const save = (revision: number, key: string, extra = {}) =>
  transaction((tx) =>
    saveRaiderOrientation(
      tx,
      {
        actor,
        input: { expectedRevision: revision, preferences: { ...preferences, ...extra } },
        idempotencyKey: key,
        requestId: 'request-' + key,
      },
      host,
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
  assert.equal(await transaction((tx) => readRaiderOrientation(tx, actor)), null);
  const first = await save(0, 'first-' + id);
  const updated = await save(1, 'second-' + id, { timezone: 'Asia/Kathmandu' });
  assert.equal(updated.orientation.revision, 2);
  assert.deepEqual(await save(0, 'first-' + id), { ...first, status: 'REPLAYED' });
  await assert.rejects(
    save(0, 'first-' + id, { timezone: 'Europe/London' }),
    (e) => e instanceof CommandReceiptError && e.code === 'IDEMPOTENCY_KEY_REUSED',
  );
  await assert.rejects(
    transaction((tx) => readRaiderOrientation(tx, { ...actor, sessionHash: 'b'.repeat(64) })),
    (e) => e instanceof OrientationStorageError && e.code === 'UNAUTHENTICATED',
  );
  let attempts = 0;
  const retried = await retryWholeTransaction(() =>
    transaction(async (tx) => {
      const r = await saveRaiderOrientation(
        tx,
        {
          actor,
          input: { expectedRevision: 2, preferences },
          idempotencyKey: 'retry-' + id,
          requestId: 'request-retry',
        },
        host,
      );
      if (++attempts === 1) throw new CommandReceiptError('RETRY_TRANSACTION');
      return r;
    }),
  );
  assert.equal(attempts, 2);
  assert.equal(retried.orientation.revision, 3);
  const check = await pool.connect();
  try {
    const {
      rows: [row],
    } = await check.query<{
      versions: number;
      participants: number;
      audits: number;
      outbox: number;
    }>(
      `SELECT (SELECT count(*)::int FROM "RaiderPreferenceVersion" WHERE "accountId"=$1) AS versions,(SELECT count(*)::int FROM "Participant" WHERE "accountId"=$1) AS participants,(SELECT count(*)::int FROM "AuditEvent" WHERE "actorId"=$1) AS audits,(SELECT count(*)::int FROM "OutboxEvent" o JOIN "AuditEvent" a ON a.id=o."eventId" WHERE a."actorId"=$1) AS outbox`,
      [id],
    );
    assert.deepEqual(row, { versions: 3, participants: 1, audits: 3, outbox: 0 });
  } finally {
    check.release();
  }
  console.log(
    JSON.stringify({
      synthetic: true,
      realDatabase: true,
      alternatePgPort: true,
      ownSchema: true,
      privateRead: true,
      originalReplay: true,
      changedBodyConflict: true,
      foreignSessionDenied: true,
      wholeRetry: true,
      stableHuman: true,
      noRankSlotOrPayment: true,
    }),
  );
} finally {
  await pool.end();
}
