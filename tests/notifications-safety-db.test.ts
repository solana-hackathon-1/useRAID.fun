import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { executeIdempotentCommand } from '../src/command-receipts';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import {
  dispatchWorkNotifications,
  listOwnNotifications,
  markNotificationRead,
} from '../src/notifications/storage';
import { submitWork } from '../src/work-loop/submission-storage';
import { seedEngagement, cmd, workInput } from './helpers/work-lifecycle';
import { seedWorkHuman } from './helpers/work-loop-db';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const db = new PrismaClient();
const run = <T>(work: Parameters<typeof runCommandTransaction<T>>[1]) =>
  runCommandTransaction(db, work);
const dispatch = (limit = 100) => run((tx) => dispatchWorkNotifications(tx, { limit }));
const own = (actor: { accountId: string; sessionHash: string }) =>
  run((tx) => listOwnNotifications(tx, actor));
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

integration('Notification operational safety (#248)', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
  });
  afterAll(() => db.$disconnect());

  it('baselines committed history on first enable and never reseeds later pending events', async () => {
    const historical = await seedEngagement(db);
    const first = await dispatch();
    expect(first.created).toBe(0);
    expect((await own(historical.worker.actor)).items).toEqual([]);
    const markerCount = await db.$queryRawUnsafe<{ n: number }[]>(
      'SELECT count(*)::int AS n FROM "NotificationDispatch"',
    );
    expect(markerCount[0].n).toBeGreaterThan(0);
    const pending = await seedEngagement(db);
    expect((await dispatch()).created).toBeGreaterThan(0);
    expect((await own(pending.worker.actor)).items.map((n) => n.kind)).toEqual([
      'ENGAGEMENT_ACCEPTED',
    ]);
    expect((await own(historical.worker.actor)).items).toEqual([]);
    expect((await dispatch()).created).toBe(0);
  });

  it('delivers an older event committed after the first-enable snapshot', async () => {
    const e = await seedEngagement(db);
    const entered = barrier();
    const release = barrier();
    const pending = run(async (tx) => {
      await submitWork(tx, cmd(e.worker.actor, workInput(e.engagementId)), {
        allowNewWrites: true,
      });
      entered.resolve();
      await release.promise;
    });
    try {
      await entered.promise;
      expect((await dispatch()).created).toBe(0);
    } finally {
      release.resolve();
      await pending;
    }
    expect((await dispatch()).created).toBe(1);
    expect((await own(e.reviewer.actor)).items.map((n) => n.kind)).toEqual(['SUBMISSION_RECEIVED']);
  });
  it('preserves pending events when upgrading an already-active dispatcher', async () => {
    await dispatch();
    await seedEngagement(db);
    await dispatch();
    const pending = await seedEngagement(db);
    // Recreate the pre-upgrade condition: old processed markers exist, but the new singleton does not.
    await db.$executeRawUnsafe('TRUNCATE "NotificationDispatchInitialization"');
    const migration = readFileSync(
      new URL(
        '../prisma/migrations/202610260009_notification_safety/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );
    const bootstrap = migration.match(
      /INSERT INTO "NotificationDispatchInitialization"[\s\S]*?;/,
    )?.[0];
    if (bootstrap) await db.$executeRawUnsafe(bootstrap);
    expect((await dispatch()).created).toBeGreaterThan(0);
    expect((await own(pending.worker.actor)).items.map((n) => n.kind)).toEqual([
      'ENGAGEMENT_ACCEPTED',
    ]);
  });

  it('marks a malformed UUID event handled and lets the next bounded batch progress', async () => {
    await dispatch();
    const actor = await seedWorkHuman(db);
    await run((tx) =>
      executeIdempotentCommand(
        tx,
        {
          actorId: actor.actor.accountId,
          commandKind: 'SyntheticNotificationProbe',
          idempotencyKey: randomUUID(),
          requestId: randomUUID(),
          request: {},
        },
        async () => ({
          resultRef: randomUUID(),
          events: [
            {
              type: 'work.engagement_committed.v1',
              aggregateId: randomUUID(),
              aggregateVersion: 1,
              payload: { engagementId: '0' + '-'.repeat(35) },
            },
          ],
        }),
      ),
    );
    const later = await seedEngagement(db);
    expect(await dispatch(1)).toEqual({ handled: 1, created: 0 });
    expect((await dispatch()).created).toBeGreaterThan(0);
    expect((await own(later.worker.actor)).items.map((n) => n.kind)).toEqual([
      'ENGAGEMENT_ACCEPTED',
    ]);
  });

  it('rejects malformed mark-read UUIDs at the reusable storage boundary', async () => {
    const actor = await seedWorkHuman(db);
    await expect(
      run((tx) => markNotificationRead(tx, actor.actor, '-'.repeat(36))),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('claims disjoint batches while another dispatcher holds its outbox lock', async () => {
    await dispatch();
    await seedEngagement(db);
    const entered = barrier();
    const release = barrier();
    const first = run(async (tx) => {
      const result = await dispatchWorkNotifications(tx, { limit: 1 });
      entered.resolve();
      await release.promise;
      return result;
    });
    let other: { handled: number; created: number } | undefined;
    try {
      await entered.promise;
      other = await run(async (tx) => {
        await tx.query("SET LOCAL statement_timeout='1500ms'", []);
        return dispatchWorkNotifications(tx, { limit: 1 });
      });
      expect(other.handled).toBe(1);
    } finally {
      release.resolve();
      expect((await first).handled).toBe(1);
    }
    const markers = await db.$queryRawUnsafe<{ n: number }[]>(
      'SELECT count(*)::int AS n FROM "NotificationDispatch"',
    );
    expect(markers[0].n).toBe(2);
  });

  it('rejects unsafe identifier/deadline values in direct SQL', async () => {
    const person = await seedWorkHuman(db);
    for (const payload of [
      { engagementId: '-'.repeat(36) },
      { engagementId: { private: 'text' } },
      { engagementId: randomUUID(), deadline: 'not a date' },
      { engagementId: randomUUID(), deadline: 'infinity' },
    ]) {
      await expect(
        db.$executeRawUnsafe(
          'INSERT INTO "Notification" ("accountId","kind","category","dedupeKey","payload") VALUES ($1,\'WORK_CLOSED\',\'TRANSACTIONAL\',$2,$3::jsonb)',
          person.actor.accountId,
          randomUUID(),
          JSON.stringify(payload),
        ),
      ).rejects.toThrow(/Notification_payload_values_check/);
    }
  });
  it('rejects a first read before notification creation in direct SQL', async () => {
    const person = await seedWorkHuman(db);
    const [saved] = await db.$queryRawUnsafe<{ id: string }[]>(
      'INSERT INTO "Notification" ("accountId","kind","category","dedupeKey","payload") VALUES ($1,\'WORK_CLOSED\',\'TRANSACTIONAL\',$2,$3::jsonb) RETURNING "id"::text',
      person.actor.accountId,
      randomUUID(),
      JSON.stringify({ engagementId: randomUUID() }),
    );
    await expect(
      db.$executeRawUnsafe(
        'UPDATE "Notification" SET "readAt"="createdAt"-interval \'1 second\' WHERE "id"=$1::uuid',
        saved.id,
      ),
    ).rejects.toThrow(/Notification_readAt_check/);
  });
});
