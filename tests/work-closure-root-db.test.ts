import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { commitEngagement } from '../src/work-loop/engagement-storage';
import { submitWork, decideReview } from '../src/work-loop/submission-storage';
import { closeOverdueBatch, type ClosurePassPorts } from '../src/work-loop/closure-pass';
import { createRootClosureHost, closeEngagementFromHost } from '../src/lib/work-closure-host';
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
const at = (ms: number) => new Date(Date.now() + ms).toISOString();
/** Waits on the database clock, which the closure guard uses, until the instant has passed. */
const untilPast = (instant: string) =>
  db.$queryRawUnsafe(
    `SELECT pg_sleep(GREATEST(0, extract(epoch FROM $1::timestamptz-clock_timestamp()))+0.05)::text AS slept`,
    instant,
  );
const row = async <T>(sql: string, ...args: string[]) =>
  (await db.$queryRawUnsafe(sql, ...args)) as T[];
const work = (engagementId: string) => ({
  engagementId,
  expectedSubmissionNumber: 1,
  explanation: 'Guide written and verified on a clean machine.',
  artifacts: [
    { kind: 'COMMIT' as const, ref: 'synthetic://repo/setup.md', immutableVersion: 'a'.repeat(40) },
  ],
  dependencies: [],
  aiUsage: null,
});
const accept = (submissionId: string) => ({
  submissionId,
  decision: 'ACCEPT' as const,
  reason: 'Reviewed against the accepted criteria.',
  criteria: [{ index: 0, result: 'MET' as const, evidence: null }],
  revisionDeadline: null,
});
const start = (engagementId: string) =>
  db.$executeRawUnsafe(
    `UPDATE "Engagement" SET "state"='IN_PROGRESS',"revision"="revision"+1 WHERE "id"=$1::uuid`,
    engagementId,
  );
const engagement = async (id: string) =>
  (
    await row<{ state: string; revision: number }>(
      'SELECT "state","revision" FROM "Engagement" WHERE "id"=$1::uuid',
      id,
    )
  )[0];
const commitments = () =>
  row<{ participantId: string; engagementId: string }>(
    'SELECT "participantId","engagementId" FROM "ActiveCommitment"',
  );
const closures = () =>
  row<{ engagementId: string; reason: string }>(
    'SELECT "engagementId"::text,"reason" FROM "EngagementClosure"',
  );
async function setup(deadlines: ReturnType<typeof soon>) {
  const worker = await seedWorkHuman(db);
  const reviewer = await seedWorkHuman(db, 'reviewer-' + randomUUID());
  const slot = await seedWorkSlot(db, undefined, {
    review: { ...raidTerms().review, reviewerAccountId: reviewer.actor.accountId },
    deadlines,
  });
  const accepted = await run((tx) =>
    commitEngagement(
      tx,
      cmd(worker.actor, { slotId: slot.slotId, termsVersionId: slot.termsVersionId }),
      syntheticAcceptanceHost,
    ),
  );
  return { worker, reviewer, engagementId: accepted.engagement.id };
}
const soon = () => ({
  commitment: at(7000),
  preparation: at(7500),
  submission: at(8000),
  review: at(8500),
  operationalClosure: at(9000),
});
const operatorId = 'ops-' + randomUUID();
const ports = (over: Partial<ClosurePassPorts> = {}): ClosurePassPorts => ({
  run: (work) => runCommandTransaction(db, work),
  host: createRootClosureHost(true, (id) => id === operatorId),
  workerAccountId: operatorId,
  limit: 25,
  ...over,
});

integration('T024 root composition: worker closure and operator closure route', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(() => db.$disconnect());

  it('closes only overdue engagements, bounded per pass, releasing each capacity exactly once', async () => {
    const deadlines = soon();
    const a = await setup(deadlines);
    const b = await setup(deadlines);
    const c = await setup(deadlines);
    const later = await setup({
      ...deadlines,
      review: at(60000),
      operationalClosure: at(61000),
    });
    await seedWorkHuman(db, operatorId);
    expect(await closeOverdueBatch(ports())).toMatchObject({ considered: 0, closed: 0 });
    await untilPast(deadlines.operationalClosure);
    const first = await closeOverdueBatch(ports({ limit: 2 }));
    expect(first).toMatchObject({ considered: 2, closed: 2, failed: [] });
    expect(await commitments()).toHaveLength(2);
    const second = await closeOverdueBatch(ports({ limit: 2 }));
    expect(second).toMatchObject({ considered: 1, closed: 1, failed: [] });
    const third = await closeOverdueBatch(ports());
    expect(third).toMatchObject({ considered: 0, closed: 0 });
    const done = await closures();
    expect(done.map((d) => d.engagementId).sort()).toEqual(
      [a, b, c].map((e) => e.engagementId).sort(),
    );
    expect(done.every((d) => d.reason === 'ACCESS_TIMEOUT')).toBe(true);
    expect(await commitments()).toEqual([
      { participantId: later.worker.participantId, engagementId: later.engagementId },
    ]);
    expect((await engagement(a.engagementId)).state).toBe('TERMINATED');
    expect((await engagement(later.engagementId)).state).toBe('ACCESS_PENDING');
  }, 40000);

  it('does not release a newer commitment or close an engagement that moved after it was read', async () => {
    const deadlines = soon();
    const { worker, reviewer, engagementId } = await setup(deadlines);
    await start(engagementId);
    const sub = await run((tx) =>
      submitWork(tx, cmd(worker.actor, work(engagementId)), { allowNewWrites: true }),
    );
    await seedWorkHuman(db, operatorId);
    await untilPast(deadlines.operationalClosure);
    let reads = 0;
    const result = await closeOverdueBatch(
      ports({
        // The reviewer accepts after the scheduler has chosen the engagement but before it closes it.
        run: async (fn) => {
          const out = await runCommandTransaction(db, fn);
          if (reads++ === 0)
            await run((tx) =>
              decideReview(tx, cmd(reviewer.actor, accept(sub.submission.id)), {
                allowNewWrites: true,
              }),
            );
          return out;
        },
      }),
    );
    expect(result.closed).toBe(0);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([{ engagementId, code: 'ENGAGEMENT_STATE' }]);
    expect(await closures()).toEqual([{ engagementId, reason: 'ACCEPTED' }]);
    // A newer engagement of the same Raider keeps its reservation; nothing later can release it.
    const next = await seedWorkSlot(db);
    const newer = await run((tx) =>
      commitEngagement(
        tx,
        cmd(worker.actor, { slotId: next.slotId, termsVersionId: next.termsVersionId }),
        syntheticAcceptanceHost,
      ),
    );
    expect(await closeOverdueBatch(ports())).toMatchObject({ considered: 0, closed: 0 });
    expect(await commitments()).toEqual([
      { participantId: worker.participantId, engagementId: newer.engagement.id },
    ]);
  }, 40000);

  it('serializes a reviewer decision racing the worker and two workers racing each other', async () => {
    const deadlines = soon();
    const raced = await setup(deadlines);
    await start(raced.engagementId);
    const sub = await run((tx) =>
      submitWork(tx, cmd(raced.worker.actor, work(raced.engagementId)), { allowNewWrites: true }),
    );
    const others = [await setup(deadlines), await setup(deadlines), await setup(deadlines)];
    await seedWorkHuman(db, operatorId);
    await untilPast(deadlines.operationalClosure);
    const settled = await Promise.allSettled([
      run((tx) =>
        decideReview(tx, cmd(raced.reviewer.actor, accept(sub.submission.id)), {
          allowNewWrites: true,
        }),
      ),
      closeOverdueBatch(ports()),
      closeOverdueBatch(ports()),
    ]);
    // The reviewer may lose to the worker, but never both outcomes, and no pass may report a failure.
    for (const r of settled.slice(1)) {
      expect(r.status).toBe('fulfilled');
      if (r.status === 'fulfilled') expect((r.value as { failed: unknown[] }).failed).toEqual([]);
    }
    const done = await closures();
    expect(done).toHaveLength(4);
    expect(new Set(done.map((d) => d.engagementId)).size).toBe(4);
    expect(done.map((d) => d.engagementId).sort()).toEqual(
      [raced, ...others].map((e) => e.engagementId).sort(),
    );
    expect(await commitments()).toEqual([]);
  }, 60000);

  it('leaves exactly one closure and one release when a submission races the worker', async () => {
    const deadlines = soon();
    const racing = await setup(deadlines);
    await start(racing.engagementId);
    await seedWorkHuman(db, operatorId);
    await untilPast(deadlines.operationalClosure);
    const [submitted, pass] = await Promise.allSettled([
      run((tx) =>
        submitWork(tx, cmd(racing.worker.actor, work(racing.engagementId)), {
          allowNewWrites: true,
        }),
      ),
      closeOverdueBatch(ports()),
    ]);
    expect(pass.status).toBe('fulfilled');
    // Whichever wins, the engagement ends closed once; a submission that landed first is closed on the next pass.
    await closeOverdueBatch(ports());
    const done = await closures();
    expect(done).toHaveLength(1);
    expect(done[0].engagementId).toBe(racing.engagementId);
    expect(await commitments()).toEqual([]);
    const subs = await row(
      'SELECT 1 FROM "WorkSubmission" WHERE "engagementId"=$1::uuid',
      racing.engagementId,
    );
    expect(subs.length).toBe(submitted.status === 'fulfilled' ? 1 : 0);
    expect((await engagement(racing.engagementId)).state).toBe('TERMINATED');
  }, 40000);

  it('refuses a worker account without a live session or without operator authority', async () => {
    const deadlines = soon();
    const a = await setup(deadlines);
    await untilPast(deadlines.operationalClosure);
    // No session for the configured account at all.
    await expect(closeOverdueBatch(ports())).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await seedWorkHuman(db, operatorId);
    // A live session but no operator authority: each engagement is refused and nothing closes.
    const denied = await closeOverdueBatch(
      ports({ host: createRootClosureHost(true, () => false) }),
    );
    expect(denied.closed).toBe(0);
    expect(denied.failed).toEqual([{ engagementId: a.engagementId, code: 'FORBIDDEN' }]);
    // Writes off: nothing closes either.
    const off = await closeOverdueBatch(ports({ host: createRootClosureHost(false, () => true) }));
    expect(off.closed).toBe(0);
    expect(await closures()).toEqual([]);
    expect(await commitments()).toHaveLength(1);
  }, 40000);

  it('closes through the operator command: replay, wrong actor, wrong state, stale revision, flag off', async () => {
    const deadlines = soon();
    const a = await setup(deadlines);
    const ops = await seedWorkHuman(db, operatorId);
    const stranger = await seedWorkHuman(db, 'stranger-' + randomUUID());
    vi.stubEnv('RAID_WORK_OPERATOR_ACCOUNT_IDS', operatorId);
    vi.stubEnv('WORK_CLOSURE_ENABLED', 'true');
    const input = async () => ({
      engagementId: a.engagementId,
      expectedRevision: (await engagement(a.engagementId)).revision,
    });
    await expect(closeEngagementFromHost(cmd(ops.actor, await input()))).rejects.toMatchObject({
      code: 'DEADLINE_NOT_REACHED',
    });
    await untilPast(deadlines.operationalClosure);
    await expect(closeEngagementFromHost(cmd(stranger.actor, await input()))).rejects.toMatchObject(
      { code: 'FORBIDDEN' },
    );
    await expect(
      closeEngagementFromHost(cmd(ops.actor, { ...(await input()), expectedRevision: 99 })),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    vi.stubEnv('WORK_CLOSURE_ENABLED', '');
    await expect(closeEngagementFromHost(cmd(ops.actor, await input()))).rejects.toMatchObject({
      code: 'WRITES_DISABLED',
    });
    expect(await closures()).toEqual([]);
    vi.stubEnv('WORK_CLOSURE_ENABLED', 'true');
    const key = randomUUID();
    const target = await input();
    const first = await closeEngagementFromHost(cmd(ops.actor, target, key));
    expect(first).toMatchObject({
      status: 'EXECUTED',
      closure: { reason: 'ACCESS_TIMEOUT', finalState: 'TERMINATED', financialResolution: 'OPEN' },
    });
    expect(await commitments()).toEqual([]);
    vi.stubEnv('WORK_CLOSURE_ENABLED', '');
    const again = await closeEngagementFromHost(cmd(ops.actor, target, key));
    expect(again).toMatchObject({ status: 'REPLAYED', closure: first.closure });
    await expect(
      closeEngagementFromHost(cmd(ops.actor, { ...target, expectedRevision: 2 }, randomUUID())),
    ).rejects.toMatchObject({ code: expect.stringMatching(/WRITES_DISABLED|ENGAGEMENT_STATE/) });
    expect(await closures()).toHaveLength(1);
  }, 40000);
});
