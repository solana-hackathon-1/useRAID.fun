import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { commitEngagement } from '../src/work-loop/engagement-storage';
import { submitWork, decideReview } from '../src/work-loop/submission-storage';
import type { SubmissionHost } from '../src/work-loop/submission-contracts';
import { raidTerms } from './helpers/raid-terms-fixture';
import { seedWorkHuman, seedWorkSlot, syntheticAcceptanceHost } from './helpers/work-loop-db';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
import { matchesBlockingObservation } from './helpers/lock-observation';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const db = new PrismaClient();
const run = <T>(work: Parameters<typeof runCommandTransaction<T>>[1]) =>
  runCommandTransaction(db, work);
const cmd = (
  actor: { accountId: string; sessionHash: string },
  input: unknown,
  key: string = randomUUID(),
) => ({ actor, input, idempotencyKey: key, requestId: key });
const host: SubmissionHost = { allowNewWrites: true };
const work = (engagementId: string, expectedSubmissionNumber = 1) => ({
  engagementId,
  expectedSubmissionNumber,
  explanation: 'Guide written and verified on a clean machine.',
  artifacts: [
    {
      kind: 'COMMIT' as const,
      ref: 'synthetic://repo/setup.md',
      immutableVersion: 'a'.repeat(40),
    },
  ],
  dependencies: ['Public synthetic repository'],
  aiUsage: null,
});
const met = [{ index: 0, result: 'MET' as const, evidence: 'Installation output attached.' }];
const unmet = [{ index: 0, result: 'UNMET' as const, evidence: 'Step three fails.' }];
const review = (
  submissionId: string,
  decision: 'ACCEPT' | 'REQUEST_REVISION' | 'DISPUTE',
  criteria: unknown = decision === 'ACCEPT' ? met : unmet,
  revisionDeadline: string | null = decision === 'REQUEST_REVISION'
    ? new Date(Date.now() + 3600000).toISOString()
    : null,
) => ({
  submissionId,
  decision,
  reason: 'Reviewed against the accepted criteria.',
  criteria,
  revisionDeadline,
});
async function setup(override: Partial<ReturnType<typeof raidTerms>> = {}) {
  const worker = await seedWorkHuman(db),
    reviewer = await seedWorkHuman(db, 'reviewer-' + randomUUID());
  const slot = await seedWorkSlot(db, undefined, {
    review: { ...raidTerms().review, reviewerAccountId: reviewer.actor.accountId },
    ...override,
  });
  const accepted = await run((tx) =>
    commitEngagement(
      tx,
      cmd(worker.actor, { slotId: slot.slotId, termsVersionId: slot.termsVersionId }),
      syntheticAcceptanceHost,
    ),
  );
  const engagementId = accepted.engagement.id;
  // Binding/access start belongs to a later task; the host moves the engagement through the guarded transition.
  await start(engagementId);
  return { worker, reviewer, slot, engagementId };
}
const start = (engagementId: string) =>
  db.$executeRawUnsafe(
    `UPDATE "Engagement" SET "state"='IN_PROGRESS',"revision"="revision"+1 WHERE "id"=$1::uuid`,
    engagementId,
  );
const submit = (actor: Parameters<typeof cmd>[0], input: unknown, h = host, key?: string) =>
  run((tx) => submitWork(tx, cmd(actor, input, key), h));
const decide = (actor: Parameters<typeof cmd>[0], input: unknown, h = host, key?: string) =>
  run((tx) => decideReview(tx, cmd(actor, input, key), h));
const state = async (engagementId: string) =>
  (
    (await db.$queryRawUnsafe(
      'SELECT "state" FROM "Engagement" WHERE "id"=$1::uuid',
      engagementId,
    )) as { state: string }[]
  )[0].state;
const commitments = () =>
  db.$queryRawUnsafe('SELECT "participantId","engagementId" FROM "ActiveCommitment"');
const txOptions = { transaction: { timeout: 15000, maxWait: 15000 } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const pid = async (tx: Prisma.TransactionClient) =>
  (await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid'))[0].pid;
async function waitFor(waiter: number, blocker: number, statement: RegExp) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const [row] = (await db.$queryRawUnsafe(
      'SELECT query,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1::int',
      String(waiter),
    )) as { query: string; blockers: number[] }[];
    if (matchesBlockingObservation(row, blocker, statement)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('Expected database blocking relationship was not observed.');
}
integration('T023 versioned submissions and criterion review', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
  });
  afterAll(() => db.$disconnect());
  it('records an immutable submission, holds capacity, and replays the original receipt', async () => {
    const { worker, engagementId } = await setup();
    const key = randomUUID();
    const first = await submit(worker.actor, work(engagementId), host, key);
    expect(first.status).toBe('EXECUTED');
    expect(first.submission.submissionNumber).toBe(1);
    expect(first.engagementState).toBe('SUBMITTED');
    expect(await state(engagementId)).toBe('SUBMITTED');
    expect(await commitments()).toHaveLength(1);
    const replay = await submit(worker.actor, work(engagementId), { allowNewWrites: false }, key);
    expect(replay.status).toBe('REPLAYED');
    expect(replay.submission.id).toBe(first.submission.id);
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "WorkSubmission"')).toHaveLength(1);
    await expect(
      db.$executeRawUnsafe(`UPDATE "WorkSubmission" SET "explanation"='changed'`),
    ).rejects.toThrow();
    await expect(db.$executeRawUnsafe('DELETE FROM "WorkSubmission"')).rejects.toThrow();
  });
  it('denies non-members, wrong state, stale numbers and disabled writes without side effects', async () => {
    const { worker, engagementId } = await setup();
    const stranger = await seedWorkHuman(db);
    await expect(submit(stranger.actor, work(engagementId))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(submit(worker.actor, work(engagementId, 2))).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    await expect(
      submit(worker.actor, work(engagementId), { allowNewWrites: false }),
    ).rejects.toMatchObject({ code: 'WRITES_DISABLED' });
    await db.$executeRawUnsafe(
      `UPDATE "Engagement" SET "state"='SUBMITTED',"revision"="revision"+1 WHERE "id"=$1::uuid`,
      engagementId,
    );
    await expect(submit(worker.actor, work(engagementId))).rejects.toMatchObject({
      code: 'ENGAGEMENT_STATE',
    });
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "WorkSubmission"')).toEqual([]);
  });
  it('limits review to the exact terms reviewer and denies self-review or incomplete criteria', async () => {
    const { worker, reviewer, engagementId } = await setup();
    const sub = await submit(worker.actor, work(engagementId));
    const other = await seedWorkHuman(db);
    for (const actor of [worker.actor, other.actor])
      await expect(decide(actor, review(sub.submission.id, 'ACCEPT'))).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    await expect(
      decide(reviewer.actor, review(sub.submission.id, 'ACCEPT', [])),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      decide(reviewer.actor, review(sub.submission.id, 'ACCEPT', unmet)),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "WorkReview"')).toEqual([]);
    expect(await state(engagementId)).toBe('SUBMITTED');
  });
  it('denies a worker named as reviewer by the terms from reviewing their own submission', async () => {
    const worker = await seedWorkHuman(db);
    const slot = await seedWorkSlot(db, undefined, {
      review: { ...raidTerms().review, reviewerAccountId: worker.actor.accountId },
    });
    const accepted = await run((tx) =>
      commitEngagement(
        tx,
        cmd(worker.actor, { slotId: slot.slotId, termsVersionId: slot.termsVersionId }),
        syntheticAcceptanceHost,
      ),
    );
    await start(accepted.engagement.id);
    const sub = await submit(worker.actor, work(accepted.engagement.id));
    await expect(decide(worker.actor, review(sub.submission.id, 'ACCEPT'))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await state(accepted.engagement.id)).toBe('SUBMITTED');
  });
  it('requires every original acceptance criterion to be judged exactly once', async () => {
    const { worker, reviewer, engagementId } = await setup({
      acceptanceCriteria: ['First original criterion.', 'Second original criterion.'],
    });
    const sub = await submit(worker.actor, work(engagementId));
    const one = { index: 0, result: 'MET' as const, evidence: null };
    for (const criteria of [[one], [one, { ...one, index: 2 }], [one, one]])
      await expect(
        decide(reviewer.actor, review(sub.submission.id, 'ACCEPT', criteria)),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await decide(reviewer.actor, review(sub.submission.id, 'ACCEPT', [one, { ...one, index: 1 }]));
    expect(await state(engagementId)).toBe('ACCEPTED');
  });
  it('accepts the work, closes it and releases only the matching participant commitment', async () => {
    const { worker, reviewer, engagementId } = await setup();
    const sub = await submit(worker.actor, work(engagementId));
    const key = randomUUID();
    const accepted = await decide(reviewer.actor, review(sub.submission.id, 'ACCEPT'), host, key);
    expect(accepted.review.decision).toBe('ACCEPT');
    expect(accepted.engagementState).toBe('ACCEPTED');
    expect(await state(engagementId)).toBe('ACCEPTED');
    expect(await commitments()).toEqual([]);
    // The participant can hold a newer engagement; replaying the old decision cannot release it.
    const next = await seedWorkSlot(db);
    const newer = await run((tx) =>
      commitEngagement(
        tx,
        cmd(worker.actor, { slotId: next.slotId, termsVersionId: next.termsVersionId }),
        syntheticAcceptanceHost,
      ),
    );
    const replay = await decide(reviewer.actor, review(sub.submission.id, 'ACCEPT'), host, key);
    expect(replay.status).toBe('REPLAYED');
    expect(await commitments()).toEqual([
      { participantId: worker.participantId, engagementId: newer.engagement.id },
    ]);
    await expect(
      decide(reviewer.actor, review(sub.submission.id, 'REQUEST_REVISION')),
    ).rejects.toMatchObject({ code: 'ENGAGEMENT_STATE' });
  });
  it('requests a bounded revision, accepts the resubmission and enforces the round limit', async () => {
    const { worker, reviewer, engagementId } = await setup();
    const first = await submit(worker.actor, work(engagementId));
    const revision = await decide(reviewer.actor, review(first.submission.id, 'REQUEST_REVISION'));
    expect(revision.engagementState).toBe('REVISION_REQUESTED');
    expect(await commitments()).toHaveLength(1);
    await expect(
      decide(reviewer.actor, review(first.submission.id, 'ACCEPT')),
    ).rejects.toMatchObject({
      code: 'ENGAGEMENT_STATE',
    });
    const second = await submit(worker.actor, work(engagementId, 2));
    expect(second.submission.submissionNumber).toBe(2);
    await expect(
      decide(reviewer.actor, review(first.submission.id, 'ACCEPT')),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    // The fixture allows exactly one revision round.
    await expect(
      decide(reviewer.actor, review(second.submission.id, 'REQUEST_REVISION')),
    ).rejects.toMatchObject({ code: 'REVISION_LIMIT' });
    await decide(reviewer.actor, review(second.submission.id, 'ACCEPT'));
    expect(await state(engagementId)).toBe('ACCEPTED');
    expect(
      await db.$queryRawUnsafe('SELECT "submissionNumber" FROM "WorkSubmission" ORDER BY 1'),
    ).toEqual([{ submissionNumber: 1 }, { submissionNumber: 2 }]);
  });
  it('requires a finite future revision deadline inside operational closure', async () => {
    const { worker, reviewer, engagementId } = await setup();
    const sub = await submit(worker.actor, work(engagementId));
    for (const deadline of [
      null,
      new Date(Date.now() - 1000).toISOString(),
      '2999-01-01T00:00:00.000Z',
    ])
      await expect(
        decide(reviewer.actor, review(sub.submission.id, 'REQUEST_REVISION', unmet, deadline)),
      ).rejects.toMatchObject({ code: expect.stringMatching(/INVALID_INPUT|DEADLINE_PASSED/) });
    expect(await state(engagementId)).toBe('SUBMITTED');
  });
  it('records a reasoned dispute without releasing capacity or allowing further decisions', async () => {
    const { worker, reviewer, engagementId } = await setup();
    const sub = await submit(worker.actor, work(engagementId));
    const disputed = await decide(reviewer.actor, review(sub.submission.id, 'DISPUTE'));
    expect(disputed.review.decision).toBe('DISPUTE');
    expect(await state(engagementId)).toBe('SUBMITTED');
    expect(await commitments()).toHaveLength(1);
    await expect(decide(reviewer.actor, review(sub.submission.id, 'ACCEPT'))).rejects.toMatchObject(
      {
        code: 'REVIEW_EXISTS',
      },
    );
    await expect(submit(worker.actor, work(engagementId, 2))).rejects.toMatchObject({
      code: 'ENGAGEMENT_STATE',
    });
  });
  it('serializes a revision request against a competing acceptance behind the real engagement lock', async () => {
    const { worker, reviewer, engagementId } = await setup();
    const sub = await submit(worker.actor, work(engagementId));
    const ready = deferred<number>(),
      waiter = deferred<number>(),
      release = deferred<void>();
    const first = runCommandTransaction(
      db,
      async (port, tx) => {
        const result = await decideReview(
          port,
          cmd(reviewer.actor, review(sub.submission.id, 'REQUEST_REVISION')),
          host,
        );
        ready.resolve(await pid(tx));
        await release.promise;
        return result;
      },
      txOptions,
    );
    let second: Promise<unknown> | undefined;
    try {
      const blocker = await Promise.race([
        ready.promise,
        first.then(() => {
          throw Error('First decision ended before its barrier.');
        }),
      ]);
      second = runCommandTransaction(
        db,
        async (port, tx) => {
          waiter.resolve(await pid(tx));
          return decideReview(port, cmd(reviewer.actor, review(sub.submission.id, 'ACCEPT')), host);
        },
        txOptions,
      );
      const results = Promise.allSettled([first, second]);
      await waitFor(
        await Promise.race([
          waiter.promise,
          second.then(() => {
            throw Error('Second decision ended before observing its backend.');
          }),
        ]),
        blocker,
        /"Engagement".*FOR UPDATE/s,
      );
      release.resolve();
      const settled = await results;
      expect(settled[0].status).toBe('fulfilled');
      expect(settled[1]).toMatchObject({
        status: 'rejected',
        reason: { code: 'ENGAGEMENT_STATE' },
      });
      expect(await state(engagementId)).toBe('REVISION_REQUESTED');
      expect(await commitments()).toHaveLength(1);
    } finally {
      release.resolve();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
  });
  it('lets exactly one of two concurrent review decisions win', async () => {
    const { worker, reviewer, engagementId } = await setup();
    const sub = await submit(worker.actor, work(engagementId));
    const results = await Promise.allSettled([
      decide(reviewer.actor, review(sub.submission.id, 'ACCEPT')),
      decide(reviewer.actor, review(sub.submission.id, 'REQUEST_REVISION')),
      decide(reviewer.actor, review(sub.submission.id, 'DISPUTE')),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "WorkReview"')).toHaveLength(1);
    const final = await state(engagementId);
    const live = (await commitments()) as unknown[];
    expect(live).toHaveLength(final === 'ACCEPTED' ? 0 : 1);
  });
  it('lets exactly one of two concurrent identical-number submissions win', async () => {
    const { worker, engagementId } = await setup();
    const results = await Promise.allSettled([
      submit(worker.actor, work(engagementId)),
      submit(worker.actor, work(engagementId)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "WorkSubmission"')).toHaveLength(1);
  });
  it('rejects submissions after the accepted submission deadline', async () => {
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    const { worker, engagementId } = await setup({
      deadlines: {
        commitment: at(3000),
        preparation: at(3500),
        submission: at(4000),
        review: at(4500),
        operationalClosure: at(5000),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 4200));
    await expect(submit(worker.actor, work(engagementId))).rejects.toMatchObject({
      code: 'DEADLINE_PASSED',
    });
  });
  it('enforces the lifecycle and capacity guards at the database even for direct writers', async () => {
    const { worker, reviewer, engagementId } = await setup();
    await expect(
      db.$executeRawUnsafe(
        `UPDATE "Engagement" SET "state"='ACCEPTED',"revision"="revision"+1 WHERE "id"=$1::uuid`,
        engagementId,
      ),
    ).rejects.toThrow();
    await expect(
      db.$executeRawUnsafe(
        `UPDATE "Engagement" SET "guildId"='other' WHERE "id"=$1::uuid`,
        engagementId,
      ),
    ).rejects.toThrow();
    await expect(db.$executeRawUnsafe('DELETE FROM "Engagement"')).rejects.toThrow();
    await expect(db.$executeRawUnsafe('DELETE FROM "ActiveCommitment"')).rejects.toThrow();
    const sub = await submit(worker.actor, work(engagementId));
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "WorkSubmission" ("engagementId","termsVersionId","submissionNumber","submitterParticipantId","explanation","artifacts","dependencies","digest") SELECT "engagementId","termsVersionId",2,"participantId",'x','[{"kind":"COMMIT","ref":"r","immutableVersion":"v"}]','[]',repeat('a',64) FROM "EngagementMember"`,
      ),
    ).rejects.toThrow();
    const accepted = await decide(reviewer.actor, review(sub.submission.id, 'ACCEPT'));
    expect(accepted.engagementState).toBe('ACCEPTED');
    await expect(
      db.$executeRawUnsafe(`UPDATE "WorkReview" SET "reason"='changed'`),
    ).rejects.toThrow();
    await expect(
      db.$executeRawUnsafe(
        `UPDATE "Engagement" SET "state"='IN_PROGRESS',"revision"="revision"+1 WHERE "id"=$1::uuid`,
        engagementId,
      ),
    ).rejects.toThrow();
  });
});
