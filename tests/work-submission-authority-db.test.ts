import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { submitWork, decideReview } from '../src/work-loop/submission-storage';
import { seedEngagement, cmd, workInput, reviewInput } from './helpers/work-lifecycle';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const db = new PrismaClient();
const run = <T>(work: Parameters<typeof runCommandTransaction<T>>[1]) =>
  runCommandTransaction(db, work);
const host = { allowNewWrites: true };
type Actor = Parameters<typeof cmd>[0];
const submit = (actor: Actor, input: unknown, key?: string) =>
  run((tx) => submitWork(tx, cmd(actor, input, key), host));
const decide = (actor: Actor, input: unknown, key?: string) =>
  run((tx) => decideReview(tx, cmd(actor, input, key), host));
const count = async (table: string) =>
  ((await db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${table}"`)) as { n: number }[])[0].n;
const engagementState = async (id: string) =>
  (
    (await db.$queryRawUnsafe('SELECT "state" FROM "Engagement" WHERE "id"=$1::uuid', id)) as {
      state: string;
    }[]
  )[0].state;
const events = async (type: string) =>
  (
    (await db.$queryRawUnsafe(
      'SELECT count(*)::int AS n FROM "AuditEvent" WHERE "eventType"=$1',
      type,
    )) as { n: number }[]
  )[0].n;

integration('T023 submission and review authority, identity and idempotency (#65)', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
  });
  afterAll(() => db.$disconnect());

  it('cannot approve an unknown submission version, or one whose terms name a different reviewer', async () => {
    const mine = await seedEngagement(db);
    const theirs = await seedEngagement(db);
    const sub = await mine.submit();
    const foreign = await theirs.submit();
    // An id that was never recorded is the same denial as a foreign one: nothing is revealed or written.
    await expect(
      decide(mine.reviewer.actor, reviewInput(randomUUID(), 'ACCEPT')),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // A reviewer named by one engagement's terms holds no authority over another engagement's submission.
    await expect(
      decide(mine.reviewer.actor, reviewInput(foreign.submission.id, 'ACCEPT')),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      decide(theirs.reviewer.actor, reviewInput(sub.submission.id, 'ACCEPT')),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await count('WorkReview')).toBe(0);
    expect(await engagementState(mine.engagementId)).toBe('SUBMITTED');
    expect(await engagementState(theirs.engagementId)).toBe('SUBMITTED');
    expect(await count('ActiveCommitment')).toBe(2);
    // The right reviewer still decides the right version.
    await decide(mine.reviewer.actor, reviewInput(sub.submission.id, 'ACCEPT'));
    expect(await engagementState(mine.engagementId)).toBe('ACCEPTED');
    expect(await engagementState(theirs.engagementId)).toBe('SUBMITTED');
  });

  it('conflicts when a key is reused with a different payload and repeats no effect on a faithful retry', async () => {
    const e = await seedEngagement(db);
    const key = randomUUID();
    const first = await submit(e.worker.actor, workInput(e.engagementId), key);
    await expect(
      submit(
        e.worker.actor,
        { ...workInput(e.engagementId), explanation: 'A different deliverable.' },
        key,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    const retry = await submit(e.worker.actor, workInput(e.engagementId), key);
    expect(retry).toMatchObject({ status: 'REPLAYED', submission: { id: first.submission.id } });
    expect(await count('WorkSubmission')).toBe(1);
    expect(await events('work.submission_recorded.v1')).toBe(1);

    const reviewKey = randomUUID();
    const decided = await decide(
      e.reviewer.actor,
      reviewInput(first.submission.id, 'REQUEST_REVISION'),
      reviewKey,
    );
    await expect(
      decide(e.reviewer.actor, reviewInput(first.submission.id, 'ACCEPT'), reviewKey),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    const again = await decide(
      e.reviewer.actor,
      reviewInput(first.submission.id, 'REQUEST_REVISION', decided.review.revisionDeadline),
      reviewKey,
    );
    expect(again).toMatchObject({ status: 'REPLAYED', review: { id: decided.review.id } });
    expect(await count('WorkReview')).toBe(1);
    expect(await events('work.review_decided.v1')).toBe(1);
    expect(await engagementState(e.engagementId)).toBe('REVISION_REQUESTED');
  });

  it('denies an expired or revoked session and a suspended account, including on replay, without any write', async () => {
    const e = await seedEngagement(db);
    const stranger = { accountId: e.worker.actor.accountId, sessionHash: '1'.repeat(64) };
    await expect(submit(stranger, workInput(e.engagementId))).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    const submitKey = randomUUID();
    const sub = await submit(e.worker.actor, workInput(e.engagementId), submitKey);
    await expect(
      decide(
        { ...e.reviewer.actor, sessionHash: '2'.repeat(64) },
        reviewInput(sub.submission.id, 'ACCEPT'),
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    // Authority is re-proved on every call: a replay of a stored receipt does not outlive the reviewer's session.
    const reviewKey = randomUUID();
    await decide(e.reviewer.actor, reviewInput(sub.submission.id, 'REQUEST_REVISION'), reviewKey);
    await db.session.update({
      where: { tokenHash: e.reviewer.actor.sessionHash },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(
      decide(e.reviewer.actor, reviewInput(sub.submission.id, 'REQUEST_REVISION'), reviewKey),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    await db.user.update({ where: { id: e.worker.actor.accountId }, data: { suspended: true } });
    await expect(submit(e.worker.actor, workInput(e.engagementId, 2))).rejects.toMatchObject({
      code: 'ACCOUNT_RESTRICTED',
    });
    await expect(
      submit(e.worker.actor, workInput(e.engagementId), submitKey),
    ).rejects.toMatchObject({ code: 'ACCOUNT_RESTRICTED' });
    expect(await count('WorkSubmission')).toBe(1);
    expect(await count('WorkReview')).toBe(1);
    expect(await engagementState(e.engagementId)).toBe('REVISION_REQUESTED');
    expect(await count('ActiveCommitment')).toBe(1);
  });

  it('refuses a suspended reviewer and leaves the submission undecided', async () => {
    const e = await seedEngagement(db);
    const sub = await e.submit();
    await db.user.update({ where: { id: e.reviewer.actor.accountId }, data: { suspended: true } });
    await expect(
      decide(e.reviewer.actor, reviewInput(sub.submission.id, 'ACCEPT')),
    ).rejects.toMatchObject({ code: 'ACCOUNT_RESTRICTED' });
    expect(await count('WorkReview')).toBe(0);
    expect(await engagementState(e.engagementId)).toBe('SUBMITTED');
    expect(await count('ActiveCommitment')).toBe(1);
  });

  it('keeps review and funding states separate: no decision moves the slot or its simulated reservation', async () => {
    const snapshot = async () => ({
      slots: await db.$queryRawUnsafe(
        'SELECT "id"::text,"state","fundingMode","fundingRef" FROM "RaidSlot" ORDER BY 1',
      ),
      reservations: await db.$queryRawUnsafe(
        'SELECT "slotId"::text,"fundingRef","vectorDigest","legs" FROM "WorkSimulatedReservation" ORDER BY 1',
      ),
    });
    const e = await seedEngagement(db);
    const before = await snapshot();
    expect((before.reservations as unknown[]).length).toBe(1);
    const first = await e.submit();
    await e.decide(first.submission.id, 'REQUEST_REVISION');
    expect(await snapshot()).toEqual(before);
    const second = await e.submit(2);
    await e.decide(second.submission.id, 'ACCEPT');
    expect(await engagementState(e.engagementId)).toBe('ACCEPTED');
    expect(await snapshot()).toEqual(before);
    // Acceptance ends the work duty only; the unpaid claim is left to settlement.
    const closure = (await db.$queryRawUnsafe(
      'SELECT "financialResolution" FROM "EngagementClosure"',
    )) as { financialResolution: string }[];
    expect(closure).toEqual([{ financialResolution: 'OPEN' }]);
  });
});
