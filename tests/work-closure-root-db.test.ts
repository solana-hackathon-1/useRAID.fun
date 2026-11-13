import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { commitEngagement } from '../src/work-loop/engagement-storage';
import { submitWork, decideReview } from '../src/work-loop/submission-storage';
import { closeOverdueEngagement } from '../src/work-loop/closure-storage';
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
/** `work.engagement_closed.v1` announcements per engagement: one per closure, and a closure releases exactly once. */
const closedEvents = () =>
  row<{ aggregateId: string; n: number }>(
    `SELECT "aggregateId","count"(*)::int AS n FROM "AuditEvent" WHERE "eventType"='work.engagement_closed.v1' GROUP BY 1 ORDER BY 1`,
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
    const [review, ...passes] = await Promise.allSettled([
      run((tx) =>
        decideReview(tx, cmd(raced.reviewer.actor, accept(sub.submission.id)), {
          allowNewWrites: true,
        }),
      ),
      closeOverdueBatch(ports()),
      closeOverdueBatch(ports()),
    ]);
    // No pass may report a failure; the only settled refusals are another writer winning or the same key replaying.
    let passClosed = 0;
    for (const r of passes) {
      expect(r.status).toBe('fulfilled');
      if (r.status !== 'fulfilled') continue;
      passClosed += r.value.closed;
      expect(r.value.failed).toEqual([]);
      for (const s of r.value.skipped) expect(['ENGAGEMENT_STATE', 'REPLAYED']).toContain(s.code);
    }
    const done = await closures();
    expect(done).toHaveLength(4);
    expect(done.map((d) => d.engagementId).sort()).toEqual(
      [raced, ...others].map((e) => e.engagementId).sort(),
    );
    // Exactly one side won the contested engagement, and the recorded reason says which. A reviewer that lost is
    // refused with the settled ENGAGEMENT_STATE answer and leaves no review behind.
    const contested = done.find((d) => d.engagementId === raced.engagementId);
    const reviews = await row(
      'SELECT 1 FROM "WorkReview" WHERE "submissionId"=$1::uuid',
      sub.submission.id,
    );
    if (review.status === 'fulfilled') {
      expect(contested?.reason).toBe('ACCEPTED');
      expect(reviews).toHaveLength(1);
      expect(passClosed).toBe(3);
    } else {
      expect(review.reason).toMatchObject({ code: 'ENGAGEMENT_STATE' });
      expect(contested?.reason).toBe('REVIEW_TIMEOUT');
      expect(reviews).toHaveLength(0);
      expect(passClosed).toBe(4);
    }
    expect(done.filter((d) => d.engagementId !== raced.engagementId).map((d) => d.reason)).toEqual(
      others.map(() => 'ACCESS_TIMEOUT'),
    );
    // Four closures, one announcement and one release each; nothing is held afterwards.
    expect(await closedEvents()).toEqual(
      done
        .map((d) => ({ aggregateId: d.engagementId, n: 1 }))
        .sort((a, b) => (a.aggregateId < b.aggregateId ? -1 : 1)),
    );
    expect(await commitments()).toEqual([]);
  }, 60000);

  it('refuses a reviewer decision that arrives after the worker closed the submitted engagement', async () => {
    const deadlines = soon();
    const { worker, reviewer, engagementId } = await setup(deadlines);
    await start(engagementId);
    const sub = await run((tx) =>
      submitWork(tx, cmd(worker.actor, work(engagementId)), { allowNewWrites: true }),
    );
    await seedWorkHuman(db, operatorId);
    await untilPast(deadlines.operationalClosure);
    expect(await closeOverdueBatch(ports())).toMatchObject({ closed: 1, failed: [] });
    await expect(
      run((tx) =>
        decideReview(tx, cmd(reviewer.actor, accept(sub.submission.id)), { allowNewWrites: true }),
      ),
    ).rejects.toMatchObject({ code: 'ENGAGEMENT_STATE' });
    expect(await closures()).toEqual([{ engagementId, reason: 'REVIEW_TIMEOUT' }]);
    expect(await closedEvents()).toEqual([{ aggregateId: engagementId, n: 1 }]);
    expect((await engagement(engagementId)).state).toBe('TERMINATED');
    expect(await commitments()).toEqual([]);
  }, 40000);

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

  it('judges the deadline on terms read after the engagement lock, so an amendment accepted during the wait extends it', async () => {
    const deadlines = soon();
    const { engagementId, worker, reviewer } = await setup(deadlines);
    await start(engagementId);
    const ops = await seedWorkHuman(db, operatorId);
    const { revision } = await engagement(engagementId);
    const extended = at(3600000);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => (locked = resolve));
    let holderPid = 0;
    // What an accepted amendment does: it takes the engagement lock and commits, without writing an Engagement row.
    const amending = db.$transaction(
      async (t) => {
        await t.$queryRawUnsafe(
          'SELECT 1 FROM "Engagement" WHERE "id"=$1::uuid FOR UPDATE',
          engagementId,
        );
        holderPid = Number(
          ((await t.$queryRawUnsafe('SELECT pg_backend_pid()::int AS pid')) as { pid: number }[])[0]
            .pid,
        );
        await t.$executeRawUnsafe(
          `INSERT INTO "EngagementAmendment" ("engagementId","sequence","snapshot","digest","proposedByAccountId","expiresAt")
           SELECT $1::uuid,1,jsonb_set(s.eff,'{deadlines,operationalClosure}',to_jsonb($3::text)),repeat('a',64),$2,(s.eff->'deadlines'->>'submission')::timestamptz-interval '1 second'
           FROM (SELECT raid_effective_terms($1::uuid) AS eff) s`,
          engagementId,
          reviewer.actor.accountId,
          extended,
        );
        await t.$executeRawUnsafe(
          `UPDATE "EngagementAmendment" SET "state"='ACCEPTED',"decidedByAccountId"=$2,"consentRef"='consent-test',"decidedAt"=clock_timestamp() WHERE "engagementId"=$1::uuid`,
          engagementId,
          worker.actor.accountId,
        );
        locked();
        await hold;
      },
      { timeout: 60000 },
    );
    await ready;
    await untilPast(deadlines.operationalClosure);
    const closing = run((tx) =>
      closeOverdueEngagement(
        tx,
        cmd(ops.actor, { engagementId, expectedRevision: revision }),
        createRootClosureHost(true, (id) => id === operatorId),
      ),
    );
    const outcome = closing.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    let blocked = false;
    // Only a session waiting on this test's own lock holder counts, so no unrelated session can satisfy the wait.
    for (let i = 0; i < 100 && !blocked; i++) {
      blocked =
        (
          (await db.$queryRawUnsafe(
            `SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1::int = ANY(pg_blocking_pids(pid))`,
            holderPid,
          )) as unknown[]
        ).length > 0;
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    release();
    await amending;
    expect(blocked).toBe(true);
    // The closer waited on the lock, then saw the extended deadline: a settled answer, not a storage failure.
    expect(await outcome).toMatchObject({ error: { code: 'DEADLINE_NOT_REACHED' } });
    expect(await closures()).toEqual([]);
    expect(await commitments()).toHaveLength(1);
    expect((await engagement(engagementId)).state).toBe('IN_PROGRESS');
  }, 60000);

  it('does not let persistently failing oldest engagements starve newer overdue ones', async () => {
    const base = soon();
    const stale = await setup({ ...base, operationalClosure: at(8800) });
    const stale2 = await setup({ ...base, operationalClosure: at(8900) });
    const fresh = await setup({ ...base, operationalClosure: at(9000) });
    const fresh2 = await setup({ ...base, operationalClosure: at(9100) });
    await seedWorkHuman(db, operatorId);
    await untilPast(at(9100));
    const broken = new Set<string>([stale.engagementId, stale2.engagementId]);
    const host = {
      allowNewWrites: true,
      authorize: async (_tx: unknown, _actor: unknown, t: { engagementId: string }) =>
        !broken.has(t.engagementId),
    };
    const pass = await closeOverdueBatch(ports({ host, limit: 2 }));
    // The two oldest keep failing, are reported, and no longer use the batch: the newer rows still close.
    expect(pass.closed).toBe(2);
    expect(pass.failed).toEqual([
      { engagementId: stale.engagementId, code: 'FORBIDDEN' },
      { engagementId: stale2.engagementId, code: 'FORBIDDEN' },
    ]);
    expect((await closures()).map((c) => c.engagementId).sort()).toEqual(
      [fresh, fresh2].map((e) => e.engagementId).sort(),
    );
    // Nothing the failing rows hold was released.
    expect((await commitments()).map((c) => c.engagementId).sort()).toEqual(
      [stale, stale2].map((e) => e.engagementId).sort(),
    );
  }, 60000);

  it('bounds a pass by `maxFailures`, stepping over failures oldest first', async () => {
    const base = soon();
    const rows = [];
    for (const ms of [8800, 8850, 8900, 8950])
      rows.push(await setup({ ...base, operationalClosure: at(ms) }));
    await seedWorkHuman(db, operatorId);
    await untilPast(at(8950));
    const host = { allowNewWrites: true, authorize: async () => false };
    // `limit` is larger than the failure budget, so only `maxFailures` can stop this pass at two of four rows.
    const pass = await closeOverdueBatch(ports({ host, limit: 10, maxFailures: 2 }));
    expect(pass).toMatchObject({ considered: 2, closed: 0, skipped: [] });
    expect(pass.failed).toEqual([
      { engagementId: rows[0].engagementId, code: 'FORBIDDEN' },
      { engagementId: rows[1].engagementId, code: 'FORBIDDEN' },
    ]);
    // The rows behind the budget were never attempted, so they still hold their reservation.
    expect(await closures()).toEqual([]);
    expect(await commitments()).toHaveLength(4);
    // A larger budget on the same rows attempts all of them, so the bound above came from `maxFailures` alone.
    await db.$executeRawUnsafe(`DELETE FROM "EngagementClosureBackoff"`);
    const wide = await closeOverdueBatch(ports({ host, limit: 10, maxFailures: 4 }));
    expect(wide.considered).toBe(4);
    expect(wide.failed.map((f) => f.engagementId)).toEqual(rows.map((r) => r.engagementId));
  }, 60000);

  it('reports a row whose terms cannot be read without aborting selection for the rest of the pass', async () => {
    const base = soon();
    const poison = await setup({ ...base, operationalClosure: at(8800) });
    const healthy = await setup({ ...base, operationalClosure: at(9000) });
    await seedWorkHuman(db, operatorId);
    await db.$transaction(async (t) => {
      await t.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
      await t.$executeRawUnsafe(
        `UPDATE "Engagement" SET "acceptedTerms"=jsonb_set("acceptedTerms",'{deadlines,operationalClosure}','"not-a-date"') WHERE "id"=$1::uuid`,
        poison.engagementId,
      );
    });
    await untilPast(at(9000));
    const pass = await closeOverdueBatch(ports());
    expect(pass.closed).toBe(1);
    expect(pass.failed).toEqual([{ engagementId: poison.engagementId, code: 'TERMS_INVALID' }]);
    expect((await closures()).map((c) => c.engagementId)).toEqual([healthy.engagementId]);
    expect((await engagement(poison.engagementId)).state).toBe('ACCESS_PENDING');
  }, 60000);

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
    await expect(closeEngagementFromHost(cmd(stranger.actor, await input()))).rejects.toMatchObject(
      { code: 'FORBIDDEN' },
    );
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
    ).rejects.toMatchObject({ code: 'WRITES_DISABLED' });
    expect(await closures()).toHaveLength(1);
  }, 40000);

  describe('durable per-engagement back-off (DEC-2026-11-13-06 a, #352 item 2)', () => {
    const backoff = () =>
      row<{
        engagementId: string;
        consecutiveFailures: number;
        lastFailureCode: string;
        delay: number;
        alerted: boolean;
      }>(
        `SELECT "engagementId"::text,"consecutiveFailures","lastFailureCode",EXTRACT(EPOCH FROM "nextAttemptAt"-clock_timestamp())::float8 AS delay,"alertedAt" IS NOT NULL AS alerted FROM "EngagementClosureBackoff" ORDER BY 1`,
      );
    /** Makes every back-off due now, as if the delay had elapsed, without waiting for it. */
    const elapse = () =>
      db.$executeRawUnsafe(`UPDATE "EngagementClosureBackoff" SET "nextAttemptAt"=clock_timestamp()`);
    const denying = (failing: Set<string>) => {
      const attempts: string[] = [];
      return {
        attempts,
        host: {
          allowNewWrites: true,
          authorize: async (_tx: unknown, _a: unknown, t: { engagementId: string }) => {
            attempts.push(t.engagementId);
            return !failing.has(t.engagementId);
          },
        },
      };
    };
    async function overdue() {
      const a = await setup(soon());
      await seedWorkHuman(db, operatorId);
      await untilPast(soon().operationalClosure);
      return a;
    }

    it('skips a failed engagement until its recorded next attempt, without closing or releasing it', async () => {
      const a = await overdue();
      const { host, attempts } = denying(new Set([a.engagementId]));
      const first = await closeOverdueBatch(ports({ host }));
      expect(first.failed).toEqual([{ engagementId: a.engagementId, code: 'FORBIDDEN' }]);
      const [rec] = await backoff();
      expect(rec).toMatchObject({
        engagementId: a.engagementId,
        consecutiveFailures: 1,
        lastFailureCode: 'FORBIDDEN',
        alerted: false,
      });
      expect(rec.delay).toBeGreaterThan(50);
      expect(rec.delay).toBeLessThanOrEqual(60);
      // A later pass inside the delay does not touch it: no attempt, no new failure, nothing closed or released.
      const second = await closeOverdueBatch(ports({ host }));
      expect(second).toMatchObject({ considered: 0, closed: 0, failed: [], skipped: [] });
      expect(attempts).toEqual([a.engagementId]);
      expect((await backoff())[0].consecutiveFailures).toBe(1);
      expect(await closures()).toEqual([]);
      expect(await commitments()).toHaveLength(1);
    }, 60000);

    it('doubles the delay from 1 minute to a 1 hour cap and keeps retrying at the cap', async () => {
      const a = await overdue();
      const { host } = denying(new Set([a.engagementId]));
      const seen: number[] = [];
      for (let n = 1; n <= 9; n++) {
        await closeOverdueBatch(ports({ host }));
        const [rec] = await backoff();
        expect(rec.consecutiveFailures).toBe(n);
        seen.push(Math.round(rec.delay / 10) * 10);
        await elapse();
      }
      expect(seen).toEqual([60, 120, 240, 480, 960, 1920, 3600, 3600, 3600]);
      expect(await commitments()).toHaveLength(1);
    }, 60000);

    it('resets on a successful close and drops the record of an engagement that is no longer active', async () => {
      const a = await overdue();
      const failing = new Set([a.engagementId]);
      const { host } = denying(failing);
      await closeOverdueBatch(ports({ host }));
      expect(await backoff()).toHaveLength(1);
      failing.clear();
      await elapse();
      expect(await closeOverdueBatch(ports({ host }))).toMatchObject({ closed: 1, failed: [] });
      expect(await backoff()).toEqual([]);
      expect(await commitments()).toEqual([]);
      // Closed by another path while backing off: the next pass removes the stale record.
      const b = await setup(soon());
      await untilPast(soon().operationalClosure);
      failing.add(b.engagementId);
      await closeOverdueBatch(ports({ host }));
      expect(await backoff()).toHaveLength(1);
      await db.$transaction(async (t) => {
        await t.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
        await t.$executeRawUnsafe(
          `UPDATE "Engagement" SET "state"='TERMINATED',"revision"="revision"+1 WHERE "id"=$1::uuid`,
          b.engagementId,
        );
      });
      await closeOverdueBatch(ports({ host }));
      expect(await backoff()).toEqual([]);
    }, 60000);

    it('raises exactly one stuck alert at the 10th consecutive failure and still retries afterwards', async () => {
      const a = await overdue();
      const { host, attempts } = denying(new Set([a.engagementId]));
      const stuck: unknown[] = [];
      for (let n = 1; n <= 12; n++) {
        const pass = await closeOverdueBatch(ports({ host }));
        stuck.push(pass.stuck);
        await elapse();
      }
      expect(stuck.slice(0, 9)).toEqual(Array(9).fill([]));
      expect(stuck[9]).toEqual([{ engagementId: a.engagementId, code: 'FORBIDDEN', failures: 10 }]);
      expect(stuck.slice(10)).toEqual([[], []]);
      expect(attempts).toHaveLength(12);
      expect((await backoff())[0]).toMatchObject({ consecutiveFailures: 12, alerted: true });
      expect(await commitments()).toHaveLength(1);
      // Worker health shows the stuck engagement while the closure worker is on.
      const { workerHealthSnapshot } = await import('../src/lib/worker-health');
      const health = await workerHealthSnapshot(new Date(), { closureEnabled: true });
      expect(health.commitments).toMatchObject({ backingOff: 0, stuck: 1 });
      await closeOverdueBatch(ports({ host }));
      expect(
        (await workerHealthSnapshot(new Date(), { closureEnabled: true })).commitments,
      ).toMatchObject({ backingOff: 1, stuck: 1 });
      expect(health.reasons).toContain('closure-stuck');
      const quiet = await workerHealthSnapshot(new Date(), { closureEnabled: false });
      expect(quiet.reasons).not.toContain('closure-stuck');
    }, 90000);

    it('backs off an engagement whose terms cannot be read', async () => {
      const poison = await setup({ ...soon(), operationalClosure: at(8800) });
      await seedWorkHuman(db, operatorId);
      await db.$transaction(async (t) => {
        await t.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
        await t.$executeRawUnsafe(
          `UPDATE "Engagement" SET "acceptedTerms"=jsonb_set("acceptedTerms",'{deadlines,operationalClosure}','"not-a-date"') WHERE "id"=$1::uuid`,
          poison.engagementId,
        );
      });
      const first = await closeOverdueBatch(ports());
      expect(first.failed).toEqual([{ engagementId: poison.engagementId, code: 'TERMS_INVALID' }]);
      expect(await closeOverdueBatch(ports())).toMatchObject({ considered: 0, failed: [] });
      expect((await backoff())[0]).toMatchObject({ lastFailureCode: 'TERMS_INVALID' });
    }, 60000);
  });
});
