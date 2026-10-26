import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { commitEngagement } from '../src/work-loop/engagement-storage';
import { submitWork, decideReview } from '../src/work-loop/submission-storage';
import { closeOverdueEngagement, readOwnEngagementClosure } from '../src/work-loop/closure-storage';
import type { ClosureHost } from '../src/work-loop/closure-contracts';
import { raidTerms } from './helpers/raid-terms-fixture';
import { seedWorkHuman, seedWorkSlot, syntheticAcceptanceHost } from './helpers/work-loop-db';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const db = new PrismaClient();
const run = <T>(work: Parameters<typeof runCommandTransaction<T>>[1]) =>
  runCommandTransaction(db, work);
type Actor = { accountId: string; sessionHash: string };
const cmd = (actor: Actor, input: unknown, key: string = randomUUID()) => ({
  actor,
  input,
  idempotencyKey: key,
  requestId: key,
});
const host: ClosureHost = {
  allowNewWrites: true,
  authorize: async (_tx, a) => a.accountId.startsWith('ops-'),
};
const at = (ms: number) => new Date(Date.now() + ms).toISOString();
const work = (engagementId: string, n = 1) => ({
  engagementId,
  expectedSubmissionNumber: n,
  explanation: 'Guide written and verified on a clean machine.',
  artifacts: [
    { kind: 'COMMIT' as const, ref: 'synthetic://repo/setup.md', immutableVersion: 'a'.repeat(40) },
  ],
  dependencies: [],
  aiUsage: null,
});
const review = (
  submissionId: string,
  decision: 'ACCEPT' | 'REQUEST_REVISION',
  revisionDeadline: string = at(3600000),
) => ({
  submissionId,
  decision,
  reason: 'Reviewed against the accepted criteria.',
  criteria: [
    decision === 'ACCEPT'
      ? { index: 0, result: 'MET' as const, evidence: null }
      : { index: 0, result: 'UNMET' as const, evidence: 'Step three fails.' },
  ],
  revisionDeadline: decision === 'REQUEST_REVISION' ? revisionDeadline : null,
});
async function setup(
  override: Partial<ReturnType<typeof raidTerms>> = {},
  worker?: Awaited<ReturnType<typeof seedWorkHuman>>,
) {
  worker ??= await seedWorkHuman(db);
  const reviewer = await seedWorkHuman(db, 'reviewer-' + randomUUID());
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
  return { worker, reviewer, slot, engagementId: accepted.engagement.id };
}
const start = (engagementId: string) =>
  db.$executeRawUnsafe(
    `UPDATE "Engagement" SET "state"='IN_PROGRESS',"revision"="revision"+1 WHERE "id"=$1::uuid`,
    engagementId,
  );
const submit = (actor: Actor, input: unknown) =>
  run((tx) => submitWork(tx, cmd(actor, input), { allowNewWrites: true }));
const decide = (actor: Actor, input: unknown) =>
  run((tx) => decideReview(tx, cmd(actor, input), { allowNewWrites: true }));
const close = (actor: Actor, input: unknown, h = host, key?: string) =>
  run((tx) => closeOverdueEngagement(tx, cmd(actor, input, key), h));
const row = async <T>(sql: string, ...args: string[]) =>
  (await db.$queryRawUnsafe(sql, ...args)) as T[];
const engagement = async (id: string) =>
  (
    await row<{ state: string; revision: number; acceptedDigest: string }>(
      'SELECT "state","revision","acceptedDigest" FROM "Engagement" WHERE "id"=$1::uuid',
      id,
    )
  )[0];
const commitments = () =>
  row<{ participantId: string; engagementId: string }>(
    'SELECT "participantId","engagementId" FROM "ActiveCommitment"',
  );
integration('T024 finite closure preserving claims and newer capacity', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
  });
  afterAll(() => db.$disconnect());
  it('releases capacity on acceptance while the unpaid claim stays visible', async () => {
    const { worker, reviewer, slot, engagementId } = await setup();
    await start(engagementId);
    const sub = await submit(worker.actor, work(engagementId));
    await decide(reviewer.actor, review(sub.submission.id, 'ACCEPT'));
    expect(await commitments()).toEqual([]);
    const closure = await row(
      'SELECT "reason","finalState","financialResolution","closedByAccountId" FROM "EngagementClosure"',
    );
    expect(closure).toEqual([
      {
        reason: 'ACCEPTED',
        finalState: 'ACCEPTED',
        financialResolution: 'OPEN',
        closedByAccountId: reviewer.actor.accountId,
      },
    ]);
    // A newer engagement does not hide or consume the earlier claim.
    const next = await seedWorkSlot(db);
    await run((tx) =>
      commitEngagement(
        tx,
        cmd(worker.actor, { slotId: next.slotId, termsVersionId: next.termsVersionId }),
        syntheticAcceptanceHost,
      ),
    );
    const seen = await run((tx) => readOwnEngagementClosure(tx, worker.actor, engagementId));
    expect(seen.closure).toMatchObject({
      finalState: 'ACCEPTED',
      reason: 'ACCEPTED',
      financialResolution: 'OPEN',
    });
    expect(seen.claims).toEqual([
      expect.objectContaining({
        amount: slot.terms.rewards[0].amount,
        beneficiaryParticipantId: worker.participantId,
        status: 'UNSETTLED',
      }),
    ]);
    const stranger = await seedWorkHuman(db);
    await expect(
      run((tx) => readOwnEngagementClosure(tx, stranger.actor, engagementId)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('refuses closure before the accepted operational deadline and for unauthorized, stale or disabled calls', async () => {
    const { worker, engagementId } = await setup();
    await start(engagementId);
    const ops = await seedWorkHuman(db, 'ops-' + randomUUID());
    const current = await engagement(engagementId);
    const input = { engagementId, expectedRevision: current.revision };
    await expect(close(ops.actor, input)).rejects.toMatchObject({ code: 'DEADLINE_NOT_REACHED' });
    await expect(close(worker.actor, input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(close(ops.actor, { ...input, engagementId: randomUUID() })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      close(ops.actor, { ...input, expectedRevision: current.revision + 5 }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(close(ops.actor, input, { ...host, allowNewWrites: false })).rejects.toMatchObject(
      { code: 'WRITES_DISABLED' },
    );
    expect(await engagement(engagementId)).toMatchObject({ state: 'IN_PROGRESS' });
    expect(await commitments()).toHaveLength(1);
    expect(await row('SELECT 1 FROM "EngagementClosure"')).toEqual([]);
  });
  it('reaches finite closure for every active state without deciding money, fault or newer capacity', async () => {
    const deadlines = {
      commitment: at(7000),
      preparation: at(7500),
      submission: at(8000),
      review: at(8500),
      operationalClosure: at(9000),
    };
    const pending = await setup({ deadlines });
    const inProgress = await setup({ deadlines });
    await start(inProgress.engagementId);
    const submitted = await setup({ deadlines });
    await start(submitted.engagementId);
    await submit(submitted.worker.actor, work(submitted.engagementId));
    const revising = await setup({ deadlines });
    await start(revising.engagementId);
    const first = await submit(revising.worker.actor, work(revising.engagementId));
    await decide(
      revising.reviewer.actor,
      review(first.submission.id, 'REQUEST_REVISION', deadlines.operationalClosure),
    );
    const raced = await setup({ deadlines });
    await start(raced.engagementId);
    const racedSub = await submit(raced.worker.actor, work(raced.engagementId));
    const ops = await seedWorkHuman(db, 'ops-' + randomUUID());
    const target = async (e: { engagementId: string }) => ({
      engagementId: e.engagementId,
      expectedRevision: (await engagement(e.engagementId)).revision,
    });
    await expect(close(ops.actor, await target(pending))).rejects.toMatchObject({
      code: 'DEADLINE_NOT_REACHED',
    });
    const before = await Promise.all(
      [pending, inProgress, submitted, revising].map((e) => engagement(e.engagementId)),
    );
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Date.parse(deadlines.operationalClosure) - Date.now() + 300)),
    );
    const expected = [
      [pending, 'ACCESS_TIMEOUT'],
      [inProgress, 'SUBMISSION_TIMEOUT'],
      [submitted, 'REVIEW_TIMEOUT'],
      [revising, 'REVISION_TIMEOUT'],
    ] as const;
    for (const [e, reason] of expected) {
      const key = randomUUID();
      const input = await target(e);
      const closed = await close(ops.actor, input, host, key);
      expect(closed.closure).toMatchObject({
        reason,
        finalState: 'TERMINATED',
        financialResolution: 'OPEN',
      });
      expect((await close(ops.actor, input, { ...host, allowNewWrites: false }, key)).status).toBe(
        'REPLAYED',
      );
      expect((await engagement(e.engagementId)).state).toBe('TERMINATED');
      await expect(close(ops.actor, await target(e))).rejects.toMatchObject({
        code: 'ENGAGEMENT_STATE',
      });
    }
    // Silence neither pays nor refunds: accepted terms and source history are untouched, and the claim remains.
    const after = await Promise.all(
      [pending, inProgress, submitted, revising].map((e) => engagement(e.engagementId)),
    );
    expect(after.map((a) => a.acceptedDigest)).toEqual(before.map((b) => b.acceptedDigest));
    expect(
      await row(
        'SELECT 1 FROM "RaidSlot" WHERE "state"<>\'FILLED\' AND "id" IN (SELECT "slotId" FROM "Engagement")',
      ),
    ).toEqual([]);
    expect(await commitments()).toEqual([
      { participantId: raced.worker.participantId, engagementId: raced.engagementId },
    ]);
    const seen = await run((tx) =>
      readOwnEngagementClosure(tx, submitted.worker.actor, submitted.engagementId),
    );
    expect(seen.closure.reason).toBe('REVIEW_TIMEOUT');
    expect(seen.claims[0]).toMatchObject({
      status: 'UNSETTLED',
      beneficiaryParticipantId: submitted.worker.participantId,
    });
    // A reviewer decision racing an operations closure leaves exactly one terminal outcome and no capacity.
    const racedTarget = await target(raced);
    const results = await Promise.allSettled([
      decide(raced.reviewer.actor, review(racedSub.submission.id, 'ACCEPT')),
      close(ops.actor, racedTarget),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await row(
        'SELECT 1 FROM "EngagementClosure" WHERE "engagementId"=$1::uuid',
        raced.engagementId,
      ),
    ).toHaveLength(1);
    expect(['ACCEPTED', 'TERMINATED']).toContain((await engagement(raced.engagementId)).state);
    expect(await commitments()).toEqual([]);
  }, 30000);
  it('cannot let a delayed closure release a newer commitment of the same participant', async () => {
    const { worker, reviewer, engagementId } = await setup();
    await start(engagementId);
    const sub = await submit(worker.actor, work(engagementId));
    await decide(reviewer.actor, review(sub.submission.id, 'ACCEPT'));
    const next = await seedWorkSlot(db);
    const newer = await run((tx) =>
      commitEngagement(
        tx,
        cmd(worker.actor, { slotId: next.slotId, termsVersionId: next.termsVersionId }),
        syntheticAcceptanceHost,
      ),
    );
    const ops = await seedWorkHuman(db, 'ops-' + randomUUID());
    // The delayed job still names the old engagement; it is already closed.
    await expect(
      close(ops.actor, {
        engagementId,
        expectedRevision: (await engagement(engagementId)).revision,
      }),
    ).rejects.toMatchObject({ code: 'ENGAGEMENT_STATE' });
    // A cleanup that deletes by participant alone would take the newer engagement's reservation and is refused.
    await expect(
      db.$executeRawUnsafe(
        'DELETE FROM "ActiveCommitment" WHERE "participantId"=$1::uuid',
        worker.participantId,
      ),
    ).rejects.toThrow();
    expect(await commitments()).toEqual([
      { participantId: worker.participantId, engagementId: newer.engagement.id },
    ]);
  });
  it('enforces closure at the database for direct writers and never reactivates closed work', async () => {
    const deadlines = {
      commitment: at(3000),
      preparation: at(3500),
      submission: at(4000),
      review: at(4500),
      operationalClosure: at(5000),
    };
    const { worker, reviewer, engagementId } = await setup({ deadlines });
    await start(engagementId);
    const ops = await seedWorkHuman(db, 'ops-' + randomUUID());
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "EngagementClosure" ("engagementId","reason","finalState","closedByAccountId") VALUES ($1::uuid,'SUBMISSION_TIMEOUT','TERMINATED',$2)`,
        engagementId,
        ops.actor.accountId,
      ),
    ).rejects.toThrow();
    await expect(
      db.$executeRawUnsafe(
        `UPDATE "Engagement" SET "state"='TERMINATED',"revision"="revision"+1 WHERE "id"=$1::uuid`,
        engagementId,
      ),
    ).rejects.toThrow();
    expect(await engagement(engagementId)).toMatchObject({ state: 'IN_PROGRESS' });
    const sub = await submit(worker.actor, work(engagementId));
    // A mismatched reason is refused even once the deadline has passed.
    await new Promise((resolve) => setTimeout(resolve, 5300));
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "EngagementClosure" ("engagementId","reason","finalState","closedByAccountId") VALUES ($1::uuid,'ACCESS_TIMEOUT','TERMINATED',$2)`,
        engagementId,
        ops.actor.accountId,
      ),
    ).rejects.toThrow();
    const closed = await close(ops.actor, {
      engagementId,
      expectedRevision: (await engagement(engagementId)).revision,
    });
    expect(closed.closure.reason).toBe('REVIEW_TIMEOUT');
    await expect(decide(reviewer.actor, review(sub.submission.id, 'ACCEPT'))).rejects.toMatchObject(
      { code: 'ENGAGEMENT_STATE' },
    );
    await expect(
      db.$executeRawUnsafe(`UPDATE "EngagementClosure" SET "reason"='ACCEPTED'`),
    ).rejects.toThrow();
    await expect(db.$executeRawUnsafe('DELETE FROM "EngagementClosure"')).rejects.toThrow();
    await expect(
      db.$executeRawUnsafe(
        `UPDATE "Engagement" SET "state"='IN_PROGRESS',"revision"="revision"+1 WHERE "id"=$1::uuid`,
        engagementId,
      ),
    ).rejects.toThrow();
  }, 20000);
});
