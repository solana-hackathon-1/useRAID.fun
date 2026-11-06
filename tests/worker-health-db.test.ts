import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ user: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('../src/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/auth')>()),
  requireUser: mocks.user,
}));
import { db } from '../src/lib/db';
import { eachStep, step } from '../src/lib/worker-jobs';
import { claimJob, enqueue, finishJob, JOB_MAX_ATTEMPTS } from '../src/lib/queue';
import {
  workerHealthSnapshot,
  recordStepOutcome,
  resetRecordingBreaker,
  STEP_STALE_MS,
  STEP_RETIRE_MS,
  RECORD_TIMEOUT_MS,
  RECORD_COOLDOWN_MS,
} from '../src/lib/worker-health';
import { GET } from '../src/app/api/admin/worker-health/route';
import { HttpError } from '../src/lib/auth-primitives';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

const suite = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const minutesAgo = (m: number, from = Date.now()) => new Date(from - m * 60000);

suite('durable worker health and generation fence (T038)', () => {
  beforeAll(() => assertTestDatabase());
  beforeEach(async () => {
    await truncateAll(db);
    await db.$executeRawUnsafe('DELETE FROM "WorkerStepHealth"');
    resetRecordingBreaker();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterAll(() => db.$disconnect());

  describe('step outcomes are durable', () => {
    it('records a success and then a failure without leaking the error message', async () => {
      await step('alpha', async () => {});
      let row = await db.workerStepHealth.findUniqueOrThrow({ where: { step: 'alpha' } });
      expect(row.lastSuccessAt).not.toBeNull();
      expect(row.consecutiveFailures).toBe(0);

      await step('alpha', async () => {
        throw new TypeError('secret token sk-live-123 in provider body');
      });
      row = await db.workerStepHealth.findUniqueOrThrow({ where: { step: 'alpha' } });
      expect(row.consecutiveFailures).toBe(1);
      expect(row.lastFailureAt).not.toBeNull();
      expect(row.lastSuccessAt).not.toBeNull();
      expect(row.lastErrorKind).toBe('TypeError');
      expect(JSON.stringify(row)).not.toContain('sk-live');
    });

    it('resets the failure streak on success but keeps the last failure time', async () => {
      await step('beta', async () => {
        throw new Error('x');
      });
      await step('beta', async () => {
        throw new Error('x');
      });
      await step('beta', async () => {});
      const row = await db.workerStepHealth.findUniqueOrThrow({ where: { step: 'beta' } });
      expect(row.consecutiveFailures).toBe(0);
      expect(row.lastFailureAt).not.toBeNull();
      expect(row.lastErrorKind).toBeNull();
    });

    it('counts concurrent failures from overlapping workers exactly', async () => {
      await Promise.all(
        Array.from({ length: 12 }, () =>
          step('gamma', async () => {
            throw new Error('x');
          }),
        ),
      );
      const row = await db.workerStepHealth.findUniqueOrThrow({ where: { step: 'gamma' } });
      expect(row.consecutiveFailures).toBe(12);
    });

    it('keeps the step result and log when the health store itself is down', async () => {
      const spy = vi.spyOn(db, '$executeRaw').mockRejectedValue(new Error('db down'));
      const fn = vi.fn(async () => {});
      await expect(step('delta', fn)).resolves.toBeUndefined();
      expect(fn).toHaveBeenCalledOnce();
      spy.mockRestore();
    });
  });

  describe('an outer step is not healthy when every per-item step failed', () => {
    const boom = async () => {
      throw new Error('x');
    };
    const outer = (ids: string[], fn: (id: string) => Promise<unknown>) =>
      step('outer', () =>
        eachStep(
          'inner',
          ids.map((id) => ({ id })),
          (item) => fn(item.id),
        ),
      );
    const row = () => db.workerStepHealth.findUniqueOrThrow({ where: { step: 'outer' } });
    it('records a failure with a safe error kind when all items fail', async () => {
      await outer(['a', 'b', 'c'], boom);
      expect(await row()).toMatchObject({
        consecutiveFailures: 1,
        lastSuccessAt: null,
        lastErrorKind: 'AllItemsFailedError',
      });
    });
    it('stays a success when at least one item succeeds, or there were no items', async () => {
      await outer(['a', 'b'], async (id) => {
        if (id === 'a') throw new Error('x');
      });
      expect((await row()).consecutiveFailures).toBe(0);
      await outer([], boom);
      expect((await row()).lastSuccessAt).not.toBeNull();
    });
    it('still logs and isolates each item failure and keeps going', async () => {
      const seen: string[] = [];
      await outer(['a', 'b'], async (id) => {
        seen.push(id);
        throw new Error('x');
      });
      expect(seen).toEqual(['a', 'b']);
    });
  });

  describe('rows for removed or renamed steps retire while the worker is alive', () => {
    it('ignores a long-dead step row once another step is running, but not when the whole worker is dead', async () => {
      const now = new Date();
      const ancient = new Date(+now - STEP_RETIRE_MS - 60000);
      await db.workerStepHealth.create({
        data: { step: 'renamed-away', lastRunAt: ancient, lastSuccessAt: ancient },
      });
      await step('alpha', async () => {});
      const live = await workerHealthSnapshot(now);
      expect(live.status).toBe('ok');
      expect(live.steps.map((s) => s.step)).toEqual(['alpha']);
      // Everything stopped (no recent heartbeat anywhere): nothing is retired, the silence stays visible.
      await db.$executeRawUnsafe(
        `UPDATE "WorkerStepHealth" SET "lastRunAt"=$1, "lastSuccessAt"=$1`,
        ancient,
      );
      const dead = await workerHealthSnapshot(now);
      expect(dead.status).toBe('degraded');
      expect(dead.reasons).toEqual(
        expect.arrayContaining(['step-stale:renamed-away', 'step-stale:alpha']),
      );
    });
    it('keeps a recently stale step visible', async () => {
      const now = new Date();
      const recent = new Date(+now - STEP_STALE_MS - 60000);
      await db.workerStepHealth.create({
        data: { step: 'slow', lastRunAt: recent, lastSuccessAt: recent },
      });
      await step('alpha', async () => {});
      expect((await workerHealthSnapshot(now)).reasons).toContain('step-stale:slow');
    });
  });

  describe('a hung health store does not slow the worker', () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });
    it('gives up after a bounded wait, then skips recording during a cooldown, then resumes', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const hung = vi
        .spyOn(db, '$executeRaw')
        .mockImplementation(() => new Promise(() => {}) as never);
      const first = recordStepOutcome('alpha');
      await vi.advanceTimersByTimeAsync(RECORD_TIMEOUT_MS + 1);
      await expect(first).resolves.toBeUndefined();
      expect(hung).toHaveBeenCalledTimes(1);
      // During the cooldown further steps return immediately without touching the database.
      await expect(recordStepOutcome('beta')).resolves.toBeUndefined();
      await expect(recordStepOutcome('gamma', { error: new Error('x') })).resolves.toBeUndefined();
      expect(hung).toHaveBeenCalledTimes(1);
      // After the cooldown it tries again.
      await vi.advanceTimersByTimeAsync(RECORD_COOLDOWN_MS + 1);
      const retry = recordStepOutcome('delta');
      await vi.advanceTimersByTimeAsync(RECORD_TIMEOUT_MS + 1);
      await retry;
      expect(hung).toHaveBeenCalledTimes(2);
    });
  });

  describe('snapshot', () => {
    it('is unknown with no heartbeat and healthy after a clean step', async () => {
      const empty = await workerHealthSnapshot();
      expect(empty.status).toBe('unknown');
      expect(empty.heartbeatAt).toBeNull();
      await step('alpha', async () => {});
      const ok = await workerHealthSnapshot();
      expect(ok.status).toBe('ok');
      expect(ok.heartbeatAt).not.toBeNull();
      expect(ok.steps.map((s) => s.step)).toEqual(['alpha']);
    });

    it('flags a stale step, a failing streak and the oldest overdue job', async () => {
      const now = new Date();
      await db.workerStepHealth.create({
        data: {
          step: 'old',
          lastRunAt: new Date(+now - STEP_STALE_MS - 60000),
          lastSuccessAt: new Date(+now - STEP_STALE_MS - 60000),
        },
      });
      await db.workerStepHealth.create({
        data: {
          step: 'bad',
          lastRunAt: now,
          lastFailureAt: now,
          consecutiveFailures: 3,
          lastErrorKind: 'Error',
        },
      });
      const stale = await workerHealthSnapshot(now);
      expect(stale.status).toBe('degraded');
      const by = Object.fromEntries(stale.steps.map((s) => [s.step, s]));
      expect(by.old.stale).toBe(true);
      expect(by.bad.stale).toBe(false);
      expect(by.bad.failing).toBe(true);
      expect(stale.reasons).toEqual(expect.arrayContaining(['step-stale:old', 'step-failing:bad']));
    });

    it('reports job age, stale leases and dead letters by count, never by payload', async () => {
      await step('alpha', async () => {});
      const overdue = await enqueue('collect', 'k-overdue', { raidId: 'r-secret-1' });
      await db.job.update({ where: { id: overdue.id }, data: { runAt: minutesAgo(20) } });
      const zombie = await enqueue('collect', 'k-zombie', { raidId: 'r2' });
      await db.job.update({
        where: { id: zombie.id },
        data: { lockedAt: minutesAgo(11), lease: 'zombie', attempts: 1 },
      });
      const dead = await enqueue('collect', 'k-dead', { raidId: 'r3' });
      await db.job.update({
        where: { id: dead.id },
        data: { failedAt: new Date(), attempts: JOB_MAX_ATTEMPTS, error: 'boom' },
      });
      // Worker crashed on every attempt: never finished, never dead-lettered, never claimable again.
      const crashed = await enqueue('collect', 'k-crashed', { raidId: 'r4' });
      await db.job.update({
        where: { id: crashed.id },
        data: { lockedAt: minutesAgo(30), lease: 'gone', attempts: JOB_MAX_ATTEMPTS },
      });
      const snap = await workerHealthSnapshot();
      expect(snap.jobs.exhausted).toBe(1);
      expect(snap.jobs.deadLettered).toBe(1);
      expect(snap.jobs.staleLeases).toBe(2);
      expect(snap.jobs.oldestRunnableAgeSeconds).toBeGreaterThanOrEqual(19 * 60);
      expect(snap.status).toBe('degraded');
      expect(snap.reasons).toEqual(
        expect.arrayContaining([
          'jobs-stale-lease',
          'jobs-dead-letter',
          'jobs-exhausted',
          'jobs-overdue',
        ]),
      );
      expect(JSON.stringify(snap)).not.toContain('r-secret-1');
      expect(JSON.stringify(snap)).not.toContain('boom');
    });

    it('measures the oldest undispatched work outbox event only when dispatch is on', async () => {
      await step('alpha', async () => {});
      const inbox = await db.inboxDelivery.create({
        data: {
          provider: 'test',
          deliveryId: 'd1',
          payloadDigest: 'a'.repeat(64),
          resultRef: 'res1',
        },
      });
      const audit = await db.$queryRaw<{ id: string }[]>`
        INSERT INTO "AuditEvent" ("inboxId","ordinal","eventType","aggregateId","aggregateVersion","actorId","correlationId","payload")
        VALUES (${inbox.id}::uuid,0,'work.closed.v1','agg',1,'actor','corr','{}'::jsonb) RETURNING "id"::text AS id`;
      await db.$executeRaw`INSERT INTO "OutboxEvent" ("eventId","createdAt") VALUES (${audit[0].id}::uuid, now() - interval '30 minutes')`;
      const off = await workerHealthSnapshot(new Date(), { outboxDispatchEnabled: false });
      expect(off.outbox).toEqual({
        dispatchEnabled: false,
        pending: null,
        oldestPendingAgeSeconds: null,
      });
      const on = await workerHealthSnapshot(new Date(), { outboxDispatchEnabled: true });
      expect(on.outbox.pending).toBe(1);
      expect(on.outbox.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(29 * 60);
      expect(on.reasons).toContain('outbox-overdue');
    });
  });

  describe('read-only admin endpoint', () => {
    it('denies non-admins and returns the snapshot to an administrator', async () => {
      mocks.user.mockRejectedValueOnce(new HttpError(403, 'Administrator access required.'));
      expect((await GET()).status).toBe(403);
      mocks.user.mockResolvedValueOnce({ id: 'a', role: 'ADMIN' });
      await step('alpha', async () => {});
      const res = await GET();
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: 'ok', steps: [{ step: 'alpha' }] });
    });
  });

  describe('generation fence: a stale lease cannot acknowledge or dead-letter work', () => {
    it('an old worker finishing after its lease was reclaimed changes nothing', async () => {
      await enqueue('collect', 'fence-1', { raidId: 'fence-raid' });
      const first = (await claimJob())!;
      expect(first.attempts).toBe(1);
      // First worker stalls past the ten-minute lease; a second worker reclaims the same job.
      await db.job.update({ where: { id: first.id }, data: { lockedAt: minutesAgo(11) } });
      const second = (await claimJob())!;
      expect(second.id).toBe(first.id);
      expect(second.lease).not.toBe(first.lease);
      // The stale worker finally reports success, then a failure at the attempt limit.
      await finishJob(first);
      await finishJob({ ...first, attempts: JOB_MAX_ATTEMPTS }, 'late failure');
      const row = await db.job.findUniqueOrThrow({ where: { id: first.id } });
      expect(row.doneAt).toBeNull();
      expect(row.failedAt).toBeNull();
      expect(row.lease).toBe(second.lease);
      // Only the current lease holder completes the job, and it cannot be claimed again.
      await finishJob(second);
      expect((await db.job.findUniqueOrThrow({ where: { id: first.id } })).doneAt).not.toBeNull();
      expect(await claimJob()).toBeNull();
    });
  });
});
