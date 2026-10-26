import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { submitWork, decideReview } from '../src/work-loop/submission-storage';
import { proposeAmendment, respondToAmendment } from '../src/work-loop/amendment-storage';
import type { AmendmentHost } from '../src/work-loop/amendment-contracts';
import {
  dispatchDeadlineReminders,
  dispatchWorkNotifications,
  listOwnNotifications,
  markNotificationRead,
  readNotificationPreferences,
  readOwnNotificationState,
  setNotificationPreferences,
} from '../src/notifications/storage';
import { categoryAllowed } from '../src/notifications/contracts';
import { raidTerms } from './helpers/raid-terms-fixture';
import { seedWorkHuman } from './helpers/work-loop-db';
import { at, cmd, reviewInput, seedEngagement, workInput } from './helpers/work-lifecycle';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const db = new PrismaClient();
const run = <T>(work: Parameters<typeof runCommandTransaction<T>>[1]) =>
  runCommandTransaction(db, work);
const dispatch = (limit = 100) => run((tx) => dispatchWorkNotifications(tx, { limit }));
const own = (actor: { accountId: string; sessionHash: string }) =>
  run((tx) => listOwnNotifications(tx, actor));
const kinds = async (actor: { accountId: string; sessionHash: string }) =>
  (await own(actor)).items.map((n) => n.kind).sort();
const row = async <T>(sql: string, ...args: string[]) =>
  (await db.$queryRawUnsafe(sql, ...args)) as T[];
async function lifecycle(override: Partial<ReturnType<typeof raidTerms>> = {}) {
  const founder = await seedWorkHuman(db, 'founder-' + randomUUID());
  const e = await seedEngagement(db, override, { founderId: founder.actor.accountId });
  return { founder, ...e };
}
integration('T042 safe lifecycle notifications and preferences', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
  });
  afterAll(() => db.$disconnect());
  it('notifies each authorized party of acceptance, submission, review and closure — once', async () => {
    const { founder, worker, reviewer, engagementId, submit } = await lifecycle();
    await dispatch();
    expect(await kinds(worker.actor)).toEqual(['ENGAGEMENT_ACCEPTED']);
    expect(await kinds(founder.actor)).toEqual(['RAID_ACCEPTED']);
    expect(await kinds(reviewer.actor)).toEqual([]);
    const sub = await submit();
    await dispatch();
    expect(await kinds(reviewer.actor)).toEqual(['SUBMISSION_RECEIVED']);
    await run((tx) =>
      decideReview(tx, cmd(reviewer.actor, reviewInput(sub.submission.id, 'REQUEST_REVISION')), {
        allowNewWrites: true,
      }),
    );
    await dispatch();
    expect(await kinds(worker.actor)).toEqual(['ENGAGEMENT_ACCEPTED', 'REVIEW_DECIDED']);
    const second = await run((tx) =>
      submitWork(tx, cmd(worker.actor, workInput(engagementId, 2)), { allowNewWrites: true }),
    );
    await run((tx) =>
      decideReview(tx, cmd(reviewer.actor, reviewInput(second.submission.id, 'ACCEPT')), {
        allowNewWrites: true,
      }),
    );
    await dispatch();
    expect(await kinds(worker.actor)).toEqual([
      'ENGAGEMENT_ACCEPTED',
      'REVIEW_DECIDED',
      'REVIEW_DECIDED',
      'WORK_CLOSED',
    ]);
    expect(await kinds(founder.actor)).toEqual(['RAID_ACCEPTED', 'RAID_CLOSED']);
    // A stranger sees nothing, and nobody sees another account's notification.
    const stranger = await seedWorkHuman(db);
    expect((await own(stranger.actor)).items).toEqual([]);
    const [foreign] = (await own(worker.actor)).items;
    await expect(
      run((tx) => markNotificationRead(tx, stranger.actor, foreign.id)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('does not duplicate a notification when the job repeats, races or replays after a lost marker', async () => {
    const { worker } = await lifecycle();
    await Promise.all([dispatch(), dispatch(), dispatch()]);
    await dispatch();
    expect(await kinds(worker.actor)).toEqual(['ENGAGEMENT_ACCEPTED']);
    const count = () =>
      row<{ n: number }>('SELECT count(*)::int AS n FROM "Notification"').then((r) => r[0].n);
    const before = await count();
    // A crash that lost the processed marker still cannot duplicate the business notification.
    await db.$executeRawUnsafe('DELETE FROM "NotificationDispatch"');
    await dispatch();
    expect(await count()).toBe(before);
  });
  it('picks up an event that committed after a newer one was already handled', async () => {
    const first = await lifecycle();
    const second = await lifecycle();
    await dispatch();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    // The first submission's transaction (older outbox timestamp) stays open while a newer one commits and is handled.
    const slow = run(async (tx) => {
      const result = await submitWork(tx, cmd(first.worker.actor, workInput(first.engagementId)), {
        allowNewWrites: true,
      });
      entered();
      await hold;
      return result;
    });
    await inside;
    await second.submit();
    await dispatch();
    expect(await kinds(second.reviewer.actor)).toEqual(['SUBMISSION_RECEIVED']);
    expect(await kinds(first.reviewer.actor)).toEqual([]);
    release();
    await slow;
    await dispatch();
    expect(await kinds(first.reviewer.actor)).toEqual(['SUBMISSION_RECEIVED']);
  });
  it('keeps private content and bearer links out of every notification', async () => {
    const secret = {
      title: 'SECRET-TITLE',
      outcome: 'SECRET-OUTCOME',
      deliverables: ['SECRET-DELIVERABLE'],
      acceptanceCriteria: ['SECRET-CRITERION'],
      publicSummary: 'SECRET-SUMMARY',
    };
    const { founder, worker, reviewer, submit } = await lifecycle(secret);
    const sub = await submit();
    await run((tx) =>
      decideReview(
        tx,
        cmd(reviewer.actor, {
          ...reviewInput(sub.submission.id, 'REQUEST_REVISION'),
          reason: 'SECRET-REASON about private code',
        }),
        { allowNewWrites: true },
      ),
    );
    await dispatch();
    const everything = JSON.stringify([
      await row('SELECT * FROM "Notification"'),
      await own(worker.actor),
      await own(founder.actor),
      await own(reviewer.actor),
    ]);
    expect(everything).not.toMatch(/SECRET/);
    expect(everything).not.toMatch(/token|bearer|[?&]key=|https?:\/\//i);
    const items = (await own(worker.actor)).items;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.link).toMatch(/^\/(raider|creator)\/work$/);
      expect(item.message.length).toBeLessThan(120);
    }
    const stored = await row<{ payload: Record<string, unknown> }>(
      'SELECT "payload" FROM "Notification"',
    );
    for (const { payload } of stored)
      expect(Object.keys(payload).every((k) => ['engagementId', 'deadline'].includes(k))).toBe(
        true,
      );
  });
  it('sends one approaching-deadline reminder per deadline version, not on every run', async () => {
    const soon = {
      deadlines: {
        commitment: at(3000),
        preparation: at(3500),
        submission: at(2 * 3600000),
        review: at(3 * 3600000),
        operationalClosure: at(4 * 3600000),
      },
    };
    const near = await lifecycle(soon);
    const far = await lifecycle();
    const reminders = () =>
      run((tx) => dispatchDeadlineReminders(tx, { withinHours: 24, limit: 100 }));
    await reminders();
    await reminders();
    expect(await kinds(near.worker.actor)).toEqual(['DEADLINE_APPROACHING']);
    expect(await kinds(far.worker.actor)).toEqual([]);
    // Once submitted, the reviewer is reminded of the review deadline; the member no longer gets submission reminders.
    await near.submit();
    await reminders();
    await reminders();
    expect(await kinds(near.reviewer.actor)).toEqual(['REVIEW_DEADLINE_APPROACHING']);
    expect(await kinds(near.worker.actor)).toEqual(['DEADLINE_APPROACHING']);
    // A reminder for a different deadline version is a different business notification.
    const [first] = await row<{ dedupeKey: string }>(
      'SELECT "dedupeKey" FROM "Notification" ORDER BY "createdAt" LIMIT 1',
    );
    expect(first.dedupeKey).toContain(near.engagementId);
  });
  it('does not remind about a deadline that has already passed', async () => {
    const past = await lifecycle({
      deadlines: {
        commitment: at(4000),
        preparation: at(4500),
        submission: at(5000),
        review: at(5500),
        operationalClosure: at(6000),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 5300));
    await run((tx) => dispatchDeadlineReminders(tx, { withinHours: 24, limit: 100 }));
    expect(await kinds(past.worker.actor)).toEqual([]);
  }, 20000);
  it('sends a new reminder when an agreed amendment moves the deadline', async () => {
    const near = await lifecycle({
      deadlines: {
        commitment: at(3000),
        preparation: at(3500),
        submission: at(2 * 3600000),
        review: at(3 * 3600000),
        operationalClosure: at(4 * 3600000),
      },
    });
    const reminders = () =>
      run((tx) => dispatchDeadlineReminders(tx, { withinHours: 24, limit: 100 }));
    await reminders();
    const host: AmendmentHost = {
      allowNewWrites: true,
      authorize: async () => true,
      reserveAdditionalFunding: async () => null,
      fundingAvailable: async () => true,
      assessConsent: async (_tx, c) => ({ consentRef: 'consent:' + c.amendmentId }),
    };
    const proposed = await run((tx) =>
      proposeAmendment(
        tx,
        cmd(near.founder.actor, {
          engagementId: near.engagementId,
          changes: {
            deadlines: {
              submission: at(4 * 3600000),
              review: at(5 * 3600000),
              operationalClosure: at(6 * 3600000),
            },
          },
          expiresAt: at(3600000),
        }),
        host,
      ),
    );
    await run((tx) =>
      respondToAmendment(
        tx,
        cmd(near.worker.actor, { amendmentId: proposed.amendment.id, decision: 'ACCEPT' }),
        host,
      ),
    );
    await reminders();
    await reminders();
    expect(await kinds(near.worker.actor)).toEqual([
      'DEADLINE_APPROACHING',
      'DEADLINE_APPROACHING',
    ]);
  });
  it('marks own notifications read idempotently and keeps unread counts per person', async () => {
    const { worker } = await lifecycle();
    await dispatch();
    const before = await own(worker.actor);
    expect(before.unread).toBe(1);
    const id = before.items[0].id;
    await run((tx) => markNotificationRead(tx, worker.actor, id));
    await run((tx) => markNotificationRead(tx, worker.actor, id));
    const after = await own(worker.actor);
    expect(after.unread).toBe(0);
    expect(after.items[0].read).toBe(true);
    await expect(
      run((tx) => markNotificationRead(tx, worker.actor, randomUUID())),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('reads the list and preferences together under one current-session proof', async () => {
    const { worker } = await lifecycle();
    await dispatch();
    const state = await run((tx) => readOwnNotificationState(tx, worker.actor));
    expect(state).toMatchObject({ version: 'v1', unread: 1, preferences: { promotional: false } });
    expect(state.items).toHaveLength(1);
    await db.session.deleteMany({ where: { userId: worker.actor.accountId } });
    await expect(run((tx) => readOwnNotificationState(tx, worker.actor))).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });
  it('defaults promotional notifications off, lets the person choose, and never suppresses transactional ones', async () => {
    const { worker } = await lifecycle();
    expect((await run((tx) => readNotificationPreferences(tx, worker.actor))).promotional).toBe(
      false,
    );
    expect(categoryAllowed('PROMOTIONAL', { promotional: false })).toBe(false);
    expect(categoryAllowed('PROMOTIONAL', { promotional: true })).toBe(true);
    expect(categoryAllowed('TRANSACTIONAL', { promotional: false })).toBe(true);
    await run((tx) => setNotificationPreferences(tx, worker.actor, { promotional: false }));
    await run((tx) => setNotificationPreferences(tx, worker.actor, { promotional: true }));
    expect((await run((tx) => readNotificationPreferences(tx, worker.actor))).promotional).toBe(
      true,
    );
    await run((tx) => setNotificationPreferences(tx, worker.actor, { promotional: false }));
    await dispatch();
    expect(await kinds(worker.actor)).toEqual(['ENGAGEMENT_ACCEPTED']);
  });
  it('is append-only apart from reading, and rejects forged duplicates or edits in the database', async () => {
    const { worker } = await lifecycle();
    await dispatch();
    const [n] = await row<{ id: string; accountId: string }>(
      'SELECT "id"::text,"accountId" FROM "Notification"',
    );
    await expect(
      db.$executeRawUnsafe(
        `UPDATE "Notification" SET "kind"='WORK_CLOSED' WHERE "id"=$1::uuid`,
        n.id,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.$executeRawUnsafe(
        `UPDATE "Notification" SET "accountId"='someone' WHERE "id"=$1::uuid`,
        n.id,
      ),
    ).rejects.toThrow(/append-only|violates/);
    await expect(db.$executeRawUnsafe('DELETE FROM "Notification"')).rejects.toThrow(/append-only/);
    await run((tx) => markNotificationRead(tx, worker.actor, n.id));
    await expect(
      db.$executeRawUnsafe(`UPDATE "Notification" SET "readAt"=NULL WHERE "id"=$1::uuid`, n.id),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "Notification" ("accountId","kind","category","dedupeKey","payload") SELECT "accountId","kind","category","dedupeKey",'{}'::jsonb FROM "Notification" LIMIT 1`,
      ),
    ).rejects.toThrow();
    // Unsupported kinds and payload keys cannot be stored.
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "Notification" ("accountId","kind","category","dedupeKey","payload") VALUES ($1,'FREE_TEXT','TRANSACTIONAL','x','{}'::jsonb)`,
        n.accountId,
      ),
    ).rejects.toThrow();
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "Notification" ("accountId","kind","category","dedupeKey","payload") VALUES ($1,'WORK_CLOSED','TRANSACTIONAL','y','{"reason":"private text"}'::jsonb)`,
        n.accountId,
      ),
    ).rejects.toThrow(/payload/);
  });
});
