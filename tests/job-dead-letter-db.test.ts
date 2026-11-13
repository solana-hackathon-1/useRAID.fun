import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  vi,
  type MockInstance,
} from 'vitest';
import { db } from '../src/lib/db';
import { claimJob, enqueue, finishJob, JOB_MAX_ATTEMPTS } from '../src/lib/queue';
import {
  renewJobLease,
  runUnderJobLease,
  assertJobLease,
  JOB_LEASE_MAX_RUN_MS,
} from '../src/lib/job-lease';
import { JobLeaseLostError } from '../src/lib/job-lease';
import { runJob, schedule, sweepExhaustedJobs } from '../src/lib/worker-jobs';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

const suite = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
// Past runAt keeps the job claimable regardless of app/database clock skew.
const past = () => new Date(Date.now() - 60_000);
// The lease is aged by the database clock, the same clock claimJob() compares against.
const ageLock = (id: string, minutes: number) =>
  db.$executeRaw`UPDATE "Job" SET "lockedAt"=(NOW() AT TIME ZONE 'UTC')-make_interval(mins => ${minutes}::int) WHERE id=${id}`;
const lockAgeSeconds = async (id: string) =>
  (
    await db.$queryRaw<
      { age: number }[]
    >`SELECT EXTRACT(EPOCH FROM ((NOW() AT TIME ZONE 'UTC')-"lockedAt"))::float8 AS age FROM "Job" WHERE id=${id}`
  )[0].age;
const MINT = 'So11111111111111111111111111111111111111112';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

suite(
  'crash-exhausted jobs dead-letter and long jobs renew their lease (DEC-2026-11-07-01 a, b)',
  () => {
    let errors: MockInstance<typeof console.error>;
    beforeAll(() => assertTestDatabase());
    beforeEach(async () => {
      await truncateAll(db);
      errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());
    afterAll(() => db.$disconnect());

    /** A job whose every attempt was claimed and abandoned (worker crash or lost lease): attempts used up, never finished. */
    const exhausted = async (
      key: string,
      payload: Record<string, unknown>,
      kind = 'submission',
    ) => {
      const job = await enqueue(kind, key, payload as never, past());
      return db.job.update({
        where: { id: job.id },
        data: {
          attempts: JOB_MAX_ATTEMPTS,
          lockedAt: new Date(Date.now() - 11 * 60000),
          lease: 'gone',
        },
      });
    };
    const submissionFixture = async (trackingVersion = 2) => {
      const user = await db.user.create({ data: { handle: 'u', xId: 'u' } });
      const raid = await db.raid.create({
        data: {
          creatorId: user.id,
          tag: 'raid_x',
          title: 'T',
          description: 'D',
          startsAt: new Date(),
          endsAt: new Date(Date.now() + 1000),
          trackingVersion,
          collectionError: 'earlier failure',
        },
      });
      const enrollment = await db.raidEnrollment.create({
        data: { raidId: raid.id, userId: user.id, xId: 'u', walletAddress: 'w' },
      });
      const sub = await db.postSubmission.create({
        data: { raidId: raid.id, enrollmentId: enrollment.id, postId: '5' },
      });
      return { raid, sub };
    };
    const alerts = () =>
      errors.mock.calls
        .map((c) => String(c[0]))
        .filter((line) => line.includes('"alert":"job-dead-letter"'));

    describe('dead-letter sweep', () => {
      it('dead-letters a lease-lost 8th attempt, excludes the QUEUED submission and alerts once', async () => {
        const { raid, sub } = await submissionFixture();
        const job = await exhausted('sub:lost', {
          raidId: raid.id,
          submissionId: sub.id,
          postId: '5',
        });
        // Reproduce the real path: the 8th attempt ran, lost its lease, and left the job without finishing it.
        expect(job.failedAt).toBeNull();
        const swept = await sweepExhaustedJobs();
        expect(swept).toEqual([job.id]);
        const after = await db.job.findUniqueOrThrow({ where: { id: job.id } });
        expect(after.failedAt).not.toBeNull();
        expect(after.error).toBeTruthy();
        expect(after.lease).toBeNull();
        expect(after.lockedAt).toBeNull();
        expect(await db.postSubmission.findUniqueOrThrow({ where: { id: sub.id } })).toMatchObject({
          status: 'EXCLUDED',
          reasonCode: 'LOOKUP_FAILED',
        });
        // The raid's collection error belonged to this job; nothing else is open, so it is cleared.
        expect(
          (await db.raid.findUniqueOrThrow({ where: { id: raid.id } })).collectionError,
        ).toBeNull();
        expect(alerts()).toHaveLength(1);
        expect(alerts()[0]).toContain(job.id);
        expect(alerts()[0]).not.toContain('earlier failure');
      });

      it('leaves live, young and finished jobs alone', async () => {
        const live = await exhausted('live', { raidId: 'a' }, 'collect');
        await db.job.update({ where: { id: live.id }, data: { lockedAt: new Date() } }); // 8th attempt still running
        const young = await enqueue('collect', 'young', { raidId: 'b' }, past());
        await db.job.update({
          where: { id: young.id },
          data: {
            attempts: JOB_MAX_ATTEMPTS - 1,
            lockedAt: new Date(Date.now() - 11 * 60000),
            lease: 'x',
          },
        });
        const done = await exhausted('done', { raidId: 'c' }, 'collect');
        await db.job.update({ where: { id: done.id }, data: { doneAt: new Date() } });
        expect(await sweepExhaustedJobs()).toEqual([]);
        expect(alerts()).toHaveLength(0);
        for (const id of [live.id, young.id, done.id])
          expect((await db.job.findUniqueOrThrow({ where: { id } })).failedAt).toBeNull();
      });

      it('is idempotent and two concurrent sweeps dead-letter and alert exactly once', async () => {
        const { raid, sub } = await submissionFixture();
        const job = await exhausted('sub:race', { raidId: raid.id, submissionId: sub.id });
        const results = await Promise.all([
          sweepExhaustedJobs(),
          sweepExhaustedJobs(),
          sweepExhaustedJobs(),
        ]);
        expect(results.flat()).toEqual([job.id]);
        expect(alerts()).toHaveLength(1);
        expect(await sweepExhaustedJobs()).toEqual([]);
      });

      it('does not resurrect a submission an administrator already moved on', async () => {
        const { raid, sub } = await submissionFixture();
        await db.postSubmission.update({ where: { id: sub.id }, data: { status: 'ACCEPTED' } });
        await exhausted('sub:moved', { raidId: raid.id, submissionId: sub.id });
        await sweepExhaustedJobs();
        expect((await db.postSubmission.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe(
          'ACCEPTED',
        );
      });

      it('a late worker that outlived its lease can neither finish nor write after the sweep', async () => {
        const { raid, sub } = await submissionFixture();
        await db.job.deleteMany();
        const job = await enqueue(
          'submission',
          'sub:late',
          { raidId: raid.id, submissionId: sub.id },
          past(),
        );
        await db.job.update({ where: { id: job.id }, data: { attempts: JOB_MAX_ATTEMPTS - 1 } });
        const claimed = (await claimJob())!; // the 8th attempt
        expect(claimed.attempts).toBe(JOB_MAX_ATTEMPTS);
        await ageLock(claimed.id, 11); // lease runs out while the worker is stalled
        await sweepExhaustedJobs();
        await finishJob(claimed); // the stalled worker wakes and reports success
        const after = await db.job.findUniqueOrThrow({ where: { id: claimed.id } });
        expect(after.doneAt).toBeNull();
        expect(after.failedAt).not.toBeNull();
        await expect(runUnderJobLease(claimed, () => assertJobLease())).rejects.toBeInstanceOf(
          JobLeaseLostError,
        );
        expect((await db.postSubmission.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe(
          'EXCLUDED',
        );
      });

      it('a worker that renews just before the sweep keeps the job; one renewing after the sweep loses it', async () => {
        const job = await exhausted('renew:race', { raidId: 'r' }, 'collect');
        const held = { id: job.id, lease: job.lease };
        // An expired lease cannot be revived by a late renewal.
        expect(await renewJobLease(held)).toBe(false); // already expired: renewal cannot revive a lost lease
        expect(await sweepExhaustedJobs()).toEqual([job.id]);
        expect(await renewJobLease(held)).toBe(false);
        const live = await exhausted('renew:live', { raidId: 's' }, 'collect');
        await ageLock(live.id, 9); // still inside the lease
        expect(await renewJobLease({ id: live.id, lease: live.lease })).toBe(true);
        expect(await sweepExhaustedJobs()).toEqual([]);
        expect(await lockAgeSeconds(live.id)).toBeLessThan(60);
      });

      it('hammering renew and sweep at the lease edge never lets both win a job', async () => {
        const job = await exhausted('hammer', { raidId: 'h' }, 'collect');
        let renewedCount = 0;
        let sweptCount = 0;
        for (let i = 0; i < 40; i++) {
          await db.job.update({
            where: { id: job.id },
            data: { failedAt: null, error: null, lease: 'edge', attempts: JOB_MAX_ATTEMPTS },
          });
          // A lock a few milliseconds either side of expiry, so renewal and sweep genuinely contend for the row.
          const edgeMs = Math.floor(Math.random() * 30) - 15;
          await db.$executeRaw`UPDATE "Job" SET "lockedAt"=(NOW() AT TIME ZONE 'UTC')-make_interval(secs => ${600 + edgeMs / 1000}::float8) WHERE id=${job.id}`;
          const [renewed, swept] = await Promise.all([
            renewJobLease({ id: job.id, lease: 'edge' }),
            sweepExhaustedJobs(),
          ]);
          const dead = swept.includes(job.id);
          const row = await db.job.findUniqueOrThrow({ where: { id: job.id } });
          // Never both. (Neither is possible in the instant between two clock readings; the next sweep settles it.)
          expect(renewed && dead).toBe(false);
          expect(row.failedAt !== null).toBe(dead);
          if (renewed) expect(row.lease).toBe('edge');
          renewedCount += renewed ? 1 : 0;
          sweptCount += dead ? 1 : 0;
        }
        expect(renewedCount + sweptCount).toBeGreaterThan(0);
      });

      it('one job whose resolution throws neither blocks the others nor goes unreported', async () => {
        const { raid, sub } = await submissionFixture();
        // A non-string submission id makes the resolution itself throw: a poison job.
        const poison = await exhausted('poison', { raidId: raid.id, submissionId: 123 });
        const healthy = await exhausted('healthy', { raidId: raid.id, submissionId: sub.id });
        expect(await sweepExhaustedJobs()).toEqual([healthy.id]);
        expect((await db.job.findUniqueOrThrow({ where: { id: poison.id } })).failedAt).toBeNull(); // rolled back whole, retried by the next sweep
        expect(
          (await db.job.findUniqueOrThrow({ where: { id: healthy.id } })).failedAt,
        ).not.toBeNull();
        expect((await db.postSubmission.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe(
          'EXCLUDED',
        );
        const failed = errors.mock.calls
          .map((c) => String(c[0]))
          .filter((line) => line.includes('"alert":"job-dead-letter-failed"'));
        expect(failed).toHaveLength(1);
        expect(failed[0]).toContain(poison.id);
        // Code plus safe class only (DEC-2026-11-07-01 d): no free-form error kind or message.
        const parsed = JSON.parse(failed[0]!);
        expect(parsed).toMatchObject({ alert: 'job-dead-letter-failed', job: poison.id });
        expect(typeof parsed.code).toBe('string');
        expect(typeof parsed.errorClass).toBe('string');
        expect(parsed).not.toHaveProperty('errorKind');
      });

      it('a crash-exhausted market job records the failure on its token', async () => {
        await db.token.create({ data: { mint: MINT, name: 'T', symbol: 'T' } });
        await exhausted('mkt', { mint: MINT }, 'market');
        await sweepExhaustedJobs();
        expect(
          (await db.token.findUniqueOrThrow({ where: { mint: MINT } })).marketError,
        ).toBeTruthy();
      });

      it('is a named schedule step so a pass repairs exhausted jobs and records health', async () => {
        const job = await exhausted('sched', { raidId: 'z' }, 'collect');
        await schedule();
        expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).failedAt).not.toBeNull();
        expect(
          await db.workerStepHealth.findUnique({ where: { step: 'job-dead-letter' } }),
        ).not.toBeNull();
      });

      it('the ordinary eighth-failure path raises the same alert', async () => {
        const { raid, sub } = await submissionFixture(1); // v1 raid that is not ACTIVE: the handler throws a plain error
        const job = await enqueue(
          'submission',
          'sub:fails',
          { raidId: raid.id, submissionId: sub.id, postId: '5' },
          past(),
        );
        await db.job.update({ where: { id: job.id }, data: { attempts: JOB_MAX_ATTEMPTS - 1 } });
        const claimed = (await claimJob())!;
        await runJob(claimed); // 8th attempt fails ordinarily and dead-letters
        expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).failedAt).not.toBeNull();
        expect(alerts()).toHaveLength(1);
      });
    });

    describe('failed-then-crashed submission repair (DEC-2026-11-13-07 b)', () => {
      /** An ordinary eighth failure whose worker crashed before resolving its submission: job failed, submission QUEUED. */
      const GRACE_MINUTES = 5;
      const ageFailure = (id: string, minutes: number) =>
        db.$executeRaw`UPDATE "Job" SET "failedAt"=(NOW() AT TIME ZONE 'UTC')-make_interval(mins => ${minutes}::int) WHERE id=${id}`;
      const failedThenCrashed = async (key: string, failedMinutesAgo = 10) => {
        const { raid, sub } = await submissionFixture();
        const job = await enqueue(
          'submission',
          key,
          { raidId: raid.id, submissionId: sub.id, postId: '5' },
          past(),
        );
        await db.job.update({
          where: { id: job.id },
          data: { attempts: JOB_MAX_ATTEMPTS, error: 'X lookup failed' },
        });
        await ageFailure(job.id, failedMinutesAgo);
        return { raid, sub, job };
      };
      const repairs = () =>
        errors.mock.calls
          .map((c) => String(c[0]))
          .filter((line) => line.includes('"alert":"job-dead-letter-repaired"'));
      const submission = (id: string) => db.postSubmission.findUniqueOrThrow({ where: { id } });

      it('excludes the QUEUED submission of a failed job, closes the raid error, never re-posts', async () => {
        const { raid, sub, job } = await failedThenCrashed('sub:crashed');
        await sweepExhaustedJobs();
        expect(await submission(sub.id)).toMatchObject({
          status: 'EXCLUDED',
          reasonCode: 'LOOKUP_FAILED',
        });
        expect(
          (await db.raid.findUniqueOrThrow({ where: { id: raid.id } })).collectionError,
        ).toBeNull();
        // The job stays failed (no auto retry) and nothing was scheduled.
        expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
          doneAt: null,
          attempts: JOB_MAX_ATTEMPTS,
        });
        expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).failedAt).not.toBeNull();
        expect(await db.job.count()).toBe(1);
        expect(repairs()).toHaveLength(1);
        expect(repairs()[0]).toContain(job.id);
        expect(repairs()[0]).not.toContain('X lookup failed');
      });

      it('is idempotent: a second sweep repairs and alerts nothing', async () => {
        await failedThenCrashed('sub:idem');
        await sweepExhaustedJobs();
        await sweepExhaustedJobs();
        expect(repairs()).toHaveLength(1);
      });

      it('leaves a submission an administrator already decided', async () => {
        const { sub } = await failedThenCrashed('sub:decided');
        await db.postSubmission.update({ where: { id: sub.id }, data: { status: 'ACCEPTED' } });
        await sweepExhaustedJobs();
        expect((await submission(sub.id)).status).toBe('ACCEPTED');
        expect(repairs()).toHaveLength(0);
      });

      it('an administrator retry revives the repaired submission and the job', async () => {
        const { sub, job } = await failedThenCrashed('sub:retry');
        await sweepExhaustedJobs();
        // What the admin retry does (src/app/api/admin/[action]/route.ts): reset the job, requeue the excluded submission.
        await db.job.update({
          where: { id: job.id },
          data: { attempts: 0, error: null, failedAt: null, runAt: past() },
        });
        await db.postSubmission.updateMany({
          where: { id: sub.id, status: 'EXCLUDED', reasonCode: 'LOOKUP_FAILED' },
          data: { status: 'QUEUED', reasonCode: null },
        });
        await sweepExhaustedJobs();
        expect((await submission(sub.id)).status).toBe('QUEUED');
        expect((await claimJob())?.id).toBe(job.id);
      });

      it('concurrency: a sweep never excludes the submission of a job a live worker is running', async () => {
        const { sub, job } = await failedThenCrashed('sub:live');
        // Administrator retry revived the job and a worker claimed it: live, unfinished, submission QUEUED.
        await db.job.update({
          where: { id: job.id },
          data: { attempts: 0, error: null, failedAt: null, runAt: past() },
        });
        const claimed = (await claimJob())!;
        expect(claimed.id).toBe(job.id);
        await runUnderJobLease(claimed, async () => {
          await Promise.all([sweepExhaustedJobs(), sweepExhaustedJobs()]);
          expect((await submission(sub.id)).status).toBe('QUEUED');
          await assertJobLease(); // the worker still owns the job
        });
        expect(repairs()).toHaveLength(0);
      });

      it('concurrency: a sweep racing an administrator retry never excludes the revived submission', async () => {
        const { sub, job } = await failedThenCrashed('sub:retryrace');
        let sweep!: Promise<unknown>;
        await db.$transaction(async (tx) => {
          // The retry holds the job row (reset to live) while the sweep, which saw it failed, tries to repair.
          await tx.job.update({
            where: { id: job.id },
            data: { attempts: 0, error: null, failedAt: null, runAt: past() },
          });
          sweep = sweepExhaustedJobs();
          await sleep(300);
        });
        await sweep;
        expect((await submission(sub.id)).status).toBe('QUEUED');
        expect(repairs()).toHaveLength(0);
      });

      it('waits out a grace period after failedAt: the gap before the worker resolves its own submission', async () => {
        const { sub, job } = await failedThenCrashed('sub:grace', 0); // finishJob just committed failedAt
        await sweepExhaustedJobs();
        expect((await submission(sub.id)).status).toBe('QUEUED');
        await ageFailure(job.id, GRACE_MINUTES - 1);
        await sweepExhaustedJobs();
        expect((await submission(sub.id)).status).toBe('QUEUED');
        await ageFailure(job.id, GRACE_MINUTES + 1);
        await sweepExhaustedJobs();
        expect((await submission(sub.id)).status).toBe('EXCLUDED');
      });

      it('skips a failed job when another live job holds the same submission (admin import-post requeue)', async () => {
        const { raid, sub } = await failedThenCrashed('sub:old');
        await enqueue(
          'submission',
          'dispute-import:d1',
          { raidId: raid.id, postId: '5', submissionId: sub.id },
          past(),
        );
        await sweepExhaustedJobs();
        expect((await submission(sub.id)).status).toBe('QUEUED');
        expect(repairs()).toHaveLength(0);
      });

      it('still repairs when the other job for the submission has also failed', async () => {
        const { raid, sub } = await failedThenCrashed('sub:old2');
        const newer = await enqueue(
          'submission',
          'dispute-import:d2',
          { raidId: raid.id, postId: '5', submissionId: sub.id },
          past(),
        );
        await db.job.update({ where: { id: newer.id }, data: { attempts: JOB_MAX_ATTEMPTS } });
        await ageFailure(newer.id, 10);
        await sweepExhaustedJobs();
        expect((await submission(sub.id)).status).toBe('EXCLUDED');
      });

      it('concurrency: a sweep racing an import-post requeue never excludes the requeued submission', async () => {
        const { raid, sub } = await failedThenCrashed('sub:importrace');
        let sweep!: Promise<unknown>;
        await db.$transaction(async (tx) => {
          // The import holds the submission row and has inserted its new job, uncommitted, when the sweep arrives.
          await tx.postSubmission.update({
            where: { id: sub.id },
            data: { status: 'QUEUED', reasonCode: null },
          });
          await tx.job.create({
            data: {
              key: 'dispute-import:race',
              kind: 'submission',
              priority: 30,
              payload: { raidId: raid.id, postId: '5', submissionId: sub.id },
            },
          });
          sweep = sweepExhaustedJobs();
          await sleep(300);
        });
        await sweep;
        expect((await submission(sub.id)).status).toBe('QUEUED');
        expect(repairs()).toHaveLength(0);
      });

      it('a throwing repair neither aborts the sweep nor hides the failed-alert of a poison dead-letter', async () => {
        const { raid } = await submissionFixture();
        const poison = await exhausted('poison2', { raidId: raid.id, submissionId: 123 });
        const real = db.$queryRaw.bind(db) as (...args: unknown[]) => unknown;
        const spy = vi
          .spyOn(db, '$queryRaw')
          .mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) =>
            strings.join('?').includes('"PostSubmission" s')
              ? Promise.reject(new Error('repair blip'))
              : real(strings, ...values)) as never);
        try {
          await expect(sweepExhaustedJobs()).resolves.toEqual([]);
        } finally {
          spy.mockRestore();
        }
        const lines = errors.mock.calls.map((c) => String(c[0]));
        expect(
          lines.filter(
            (l) => l.includes('"alert":"job-dead-letter-failed"') && l.includes(poison.id),
          ),
        ).toHaveLength(1);
        const repairFailed = lines.filter((l) => l.includes('"alert":"job-repair-failed"'));
        expect(repairFailed).toHaveLength(1);
        expect(repairFailed[0]).not.toContain('repair blip');
      });

      it('never repairs a job that still holds a lease', async () => {
        const { sub, job } = await failedThenCrashed('sub:leased');
        await db.job.update({ where: { id: job.id }, data: { lease: 'held' } });
        await sweepExhaustedJobs();
        expect((await submission(sub.id)).status).toBe('QUEUED');
      });

      it('stamps failedAt with the database clock: a lagging app clock cannot backdate it past the grace period', async () => {
        const { sub } = await submissionFixture();
        await db.job.deleteMany();
        const job = await enqueue(
          'submission',
          'sub:skew',
          { raidId: (await db.raid.findFirstOrThrow()).id, submissionId: sub.id, postId: '5' },
          past(),
        );
        await db.job.update({ where: { id: job.id }, data: { attempts: JOB_MAX_ATTEMPTS - 1 } });
        const claimed = (await claimJob())!;
        expect(claimed.attempts).toBe(JOB_MAX_ATTEMPTS);
        vi.useFakeTimers({ toFake: ['Date'], now: Date.now() - 3_600_000 }); // app clock one hour behind the database
        try {
          expect(await finishJob(claimed, 'X lookup failed')).toEqual({ dead: true });
        } finally {
          vi.useRealTimers();
        }
        const [{ skew }] = await db.$queryRaw<
          { skew: number }[]
        >`SELECT ABS(EXTRACT(EPOCH FROM ((NOW() AT TIME ZONE 'UTC') - "failedAt")))::float8 AS skew FROM "Job" WHERE id=${job.id}`;
        expect(skew).toBeLessThan(30);
        await sweepExhaustedJobs(); // inside the grace period by the database clock: not mistaken for a crash
        expect((await submission(sub.id)).status).toBe('QUEUED');
      });

      it('concurrent sweeps repair and alert exactly once', async () => {
        const { sub } = await failedThenCrashed('sub:two');
        await Promise.all([sweepExhaustedJobs(), sweepExhaustedJobs(), sweepExhaustedJobs()]);
        expect((await submission(sub.id)).status).toBe('EXCLUDED');
        expect(repairs()).toHaveLength(1);
      });
    });

    describe('total-run cap on lease renewal (DEC-2026-11-13-07 a)', () => {
      const frozenAppClock = (offsetMs: number) => {
        const t0 = Date.now() + offsetMs;
        const p0 = performance.now() + offsetMs;
        return [
          vi.spyOn(Date, 'now').mockReturnValue(t0),
          vi.spyOn(performance, 'now').mockReturnValue(p0),
        ];
      };

      it('caps one attempt at 60 minutes of renewal', () => {
        expect(JOB_LEASE_MAX_RUN_MS).toBe(60 * 60000);
      });

      it('stops renewing at the cap and refuses at once, before the lease has expired', async () => {
        await enqueue('collect', 'capped', { raidId: 'cap' }, past());
        const claimed = (await claimJob())!;
        await runUnderJobLease(
          claimed,
          async () => {
            await sleep(250); // past the 100 ms cap
            await expect(assertJobLease()).rejects.toBeInstanceOf(JobLeaseLostError);
            // The database still shows the lease as live (refusal is immediate, not waiting for expiry)...
            expect(await lockAgeSeconds(claimed.id)).toBeLessThan(60);
            await ageLock(claimed.id, 5);
            await sleep(150); // ...and further ticks do not renew it.
            expect(await lockAgeSeconds(claimed.id)).toBeGreaterThan(290);
          },
          { renewEveryMs: 20, maxRunMs: 100 },
        );
        const lines = errors.mock.calls.map((c) => String(c[0]));
        expect(lines.filter((l) => l.includes('"code":"JOB_LEASE_CAP"'))).toHaveLength(1);
      });

      describe('with a non-UTC session TimeZone', () => {
        const withTimeZone = async (zone: string, fn: () => Promise<void>) => {
          await db.$executeRawUnsafe(`ALTER ROLE CURRENT_USER SET TimeZone='${zone}'`);
          await db.$disconnect();
          await db.$connect();
          try {
            await fn();
          } finally {
            await db.$executeRawUnsafe(`ALTER ROLE CURRENT_USER RESET TimeZone`);
            await db.$disconnect();
            await db.$connect();
          }
        };
        const hold = async (key: string, claimedAgoMs: number, probe: () => Promise<void>) => {
          await enqueue('collect', key, { raidId: key }, past());
          const claimed = (await claimJob())!;
          const lockedAt = new Date(Date.now() - claimedAgoMs);
          await runUnderJobLease({ ...claimed, lockedAt }, probe, {
            renewEveryMs: 20,
            maxRunMs: 3_600_000,
          });
        };

        it('caps a run that is past 60 minutes when the session zone is ahead of UTC', async () => {
          await withTimeZone('Pacific/Kiritimati', async () => {
            await hold('tz-ahead', 2 * 3_600_000, async () => {
              await sleep(200);
              await expect(assertJobLease()).rejects.toBeInstanceOf(JobLeaseLostError);
            });
          });
        });

        it('does not cap a young run early when the session zone is behind UTC', async () => {
          await withTimeZone('Pacific/Pago_Pago', async () => {
            await hold('tz-behind', 1000, async () => {
              await sleep(200);
              await assertJobLease();
            });
          });
        });
      });

      it('still renews before the cap', async () => {
        await enqueue('collect', 'uncapped', { raidId: 'cap2' }, past());
        const claimed = (await claimJob())!;
        await ageLock(claimed.id, 9);
        await runUnderJobLease(
          claimed,
          async () => {
            await sleep(120);
            expect(await lockAgeSeconds(claimed.id)).toBeLessThan(60);
            await assertJobLease();
          },
          { renewEveryMs: 20, maxRunMs: 10_000 },
        );
      });

      it('measures the cap from the claim by the database clock: an app clock 10 hours ahead does not trip it', async () => {
        await enqueue('collect', 'skew-ahead', { raidId: 'cap3' }, past());
        const claimed = (await claimJob())!;
        const clocks = frozenAppClock(10 * 3600_000);
        try {
          await runUnderJobLease(
            claimed,
            async () => {
              await sleep(150);
              await assertJobLease();
              expect(await lockAgeSeconds(claimed.id)).toBeLessThan(60);
            },
            { renewEveryMs: 20, maxRunMs: 60_000 },
          );
        } finally {
          clocks.forEach((c) => c.mockRestore());
        }
      });

      it('measures the cap from the claim by the database clock: a frozen app clock does not hide it', async () => {
        await enqueue('collect', 'skew-frozen', { raidId: 'cap4' }, past());
        const claimed = (await claimJob())!;
        const clocks = frozenAppClock(0);
        try {
          await runUnderJobLease(
            claimed,
            async () => {
              await sleep(250);
              await expect(assertJobLease()).rejects.toBeInstanceOf(JobLeaseLostError);
            },
            { renewEveryMs: 20, maxRunMs: 100 },
          );
        } finally {
          clocks.forEach((c) => c.mockRestore());
        }
      });

      it('applies the 60-minute cap by default: a handler that never settles stops renewing and is refused', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        const claimedAt = new Date('2026-11-13T10:00:00.000Z');
        let capped = false;
        const renew = vi.spyOn(db, '$executeRaw').mockResolvedValue(1);
        const capQuery = vi
          .spyOn(db, '$queryRaw')
          .mockImplementation((() => Promise.resolve([{ capped }])) as never);
        try {
          let release!: () => void;
          let refused: unknown;
          const run = runUnderJobLease({ id: 'j', lease: 'l', lockedAt: claimedAt }, async () => {
            await new Promise<void>((resolve) => (release = resolve));
            refused = await assertJobLease().then(
              () => null,
              (e) => e,
            );
          });
          await vi.advanceTimersByTimeAsync(59 * 60000);
          const beforeCap = renew.mock.calls.length;
          expect(beforeCap).toBeGreaterThan(10);
          // The cap is asked of the database against the claim time, with the 60-minute default.
          const [, ...values] = capQuery.mock.calls.at(-1)! as unknown[];
          expect(values).toContain(3600);
          expect(values).toContainEqual(claimedAt);
          capped = true; // the database says 60 minutes have passed since the claim
          await vi.advanceTimersByTimeAsync(5 * 60000);
          const atCap = renew.mock.calls.length;
          await vi.advanceTimersByTimeAsync(30 * 60000);
          expect(renew.mock.calls.length).toBe(atCap);
          release();
          await run;
          expect(refused).toBeInstanceOf(JobLeaseLostError);
        } finally {
          renew.mockRestore();
          capQuery.mockRestore();
          vi.useRealTimers();
        }
      });
    });

    describe('lease renewal', () => {
      it('keeps a long job leased: renews on an interval and stops when the handler ends', async () => {
        const job = await enqueue('collect', 'long', { raidId: 'l' }, past());
        const claimed = (await claimJob())!;
        await ageLock(claimed.id, 9); // nearly out of lease
        await runUnderJobLease(
          claimed,
          async () => {
            await sleep(400);
            await assertJobLease(); // would throw without renewal if the lock were older than the lease
            expect(await lockAgeSeconds(job.id)).toBeLessThan(60);
          },
          { renewEveryMs: 50 },
        );
        const lockedBefore = await db.job.findUniqueOrThrow({ where: { id: job.id } });
        await sleep(200);
        const lockedAfter = await db.job.findUniqueOrThrow({ where: { id: job.id } });
        expect(+lockedAfter.lockedAt!).toBe(+lockedBefore.lockedAt!); // no renewals after the handler returned
      });

      it('a job that would have run past the lease is not reclaimed by another worker while it renews', async () => {
        await enqueue('collect', 'long2', { raidId: 'm' }, past());
        const claimed = (await claimJob())!;
        await ageLock(claimed.id, 9);
        let stolen: unknown = 'unset';
        await runUnderJobLease(
          claimed,
          async () => {
            await sleep(300);
            await ageLock(claimed.id, 0); // the DB clock moved: lease still fresh thanks to renewal
            stolen = await claimJob();
          },
          { renewEveryMs: 50 },
        );
        expect(stolen).toBeNull();
      });

      it('stops spending once the lease is lost: the handler learns at once and renewal never revives it', async () => {
        await enqueue('collect', 'lost', { raidId: 'n' }, past());
        const stale = (await claimJob())!;
        await ageLock(stale.id, 11);
        const current = (await claimJob())!;
        expect(current.lease).not.toBe(stale.lease);
        await expect(
          runUnderJobLease(
            stale,
            async () => {
              await sleep(200); // several renewal ticks all fail
              await assertJobLease();
            },
            { renewEveryMs: 50 },
          ),
        ).rejects.toBeInstanceOf(JobLeaseLostError);
        const row = await db.job.findUniqueOrThrow({ where: { id: stale.id } });
        expect(row.lease).toBe(current.lease);
        expect(await lockAgeSeconds(stale.id)).toBeLessThan(60); // current holder's own lock, untouched by the stale worker
      });

      it('a handler that throws synchronously still stops the renewal timer', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        try {
          await expect(
            runUnderJobLease({ id: 'j', lease: 'l' }, () => {
              throw new Error('sync');
            }),
          ).rejects.toThrow('sync');
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          vi.useRealTimers();
        }
      });

      it('a failed renewal (database blip) does not abort the job; the next check decides', async () => {
        await enqueue('collect', 'blip', { raidId: 'o' }, past());
        const claimed = (await claimJob())!;
        const spy = vi
          .spyOn(db, '$executeRaw')
          .mockRejectedValueOnce(new Error('connection reset'));
        await expect(
          runUnderJobLease(
            claimed,
            async () => {
              await sleep(150);
              await assertJobLease();
              return 'done';
            },
            { renewEveryMs: 50 },
          ),
        ).resolves.toBe('done');
        spy.mockRestore();
      });
    });
  },
);
