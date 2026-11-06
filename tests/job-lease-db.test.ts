import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { db } from '../src/lib/db';
import { claimJob, enqueue } from '../src/lib/queue';
import { runJob } from '../src/lib/worker-jobs';
import { assertJobLease, JobLeaseLostError, runUnderJobLease } from '../src/lib/job-lease';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
const suite = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const MINT = 'So11111111111111111111111111111111111111112';
// Past runAt keeps the job claimable regardless of app/database clock skew.
const due = (key: string) => enqueue('market', key, { mint: MINT }, new Date(Date.now() - 60_000));
// The lease is "expired" by the database clock, the same clock claimJob() compares against.
const expireLease = (id: string) =>
  db.$executeRaw`UPDATE "Job" SET "lockedAt"=(NOW() AT TIME ZONE 'UTC')-INTERVAL '11 minutes' WHERE id=${id}`;
suite('pre-effect job lease fence (T038)', () => {
  const providerCalls = vi.fn();
  beforeAll(() => assertTestDatabase());
  beforeEach(async () => {
    await truncateAll(db);
    await db.token.create({ data: { mint: MINT, symbol: 'SOL', name: 'Solana' } });
    providerCalls.mockReset();
    providerCalls.mockImplementation(async () => Response.json([]));
    vi.stubGlobal('fetch', providerCalls);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  afterAll(() => db.$disconnect());
  it('refuses a stale worker after another worker reclaims the job, so the provider effect runs once', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await due('market:lease:1');
    const stale = (await claimJob())!;
    await expireLease(stale.id);
    const current = (await claimJob())!;
    expect(current.id).toBe(stale.id);
    expect(current.lease).not.toBe(stale.lease);
    await runJob(stale); // worker A wakes up late: its pre-effect check must refuse
    expect(providerCalls).not.toHaveBeenCalled();
    const afterStale = await db.job.findUniqueOrThrow({ where: { id: stale.id } });
    expect(afterStale.lease).toBe(current.lease); // stale worker did not release or fail the new holder's job
    expect(afterStale.error).toBeNull();
    expect((await db.token.findUniqueOrThrow({ where: { mint: MINT } })).marketError).toBeNull();
    await runJob(current);
    expect(providerCalls).toHaveBeenCalledTimes(1);
    expect((await db.job.findUniqueOrThrow({ where: { id: stale.id } })).doneAt).not.toBeNull();
  });
  it('refuses an expired lease that nobody has reclaimed yet, using the database clock', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await due('market:lease:2');
    const job = (await claimJob())!;
    await expect(runUnderJobLease(job, () => assertJobLease())).resolves.toBeUndefined();
    await expireLease(job.id);
    await expect(runUnderJobLease(job, () => assertJobLease())).rejects.toBeInstanceOf(
      JobLeaseLostError,
    );
    await runJob(job);
    expect(providerCalls).not.toHaveBeenCalled();
  });
  it('refuses a job that was already finished or dead-lettered by someone else', async () => {
    await due('market:lease:3');
    const job = (await claimJob())!;
    await db.job.update({ where: { id: job.id }, data: { failedAt: new Date() } });
    await expect(runUnderJobLease(job, () => assertJobLease())).rejects.toBeInstanceOf(
      JobLeaseLostError,
    );
  });
  it('judges expiry by the database clock whatever the app clock says', async () => {
    await due('market:lease:4');
    const job = (await claimJob())!;
    const check = () => runUnderJobLease(job, () => assertJobLease());
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 3_600_000); // app clock an hour ahead: a live lease must still be honoured
      await expect(check()).resolves.toBeUndefined();
      vi.useRealTimers();
      await expireLease(job.id);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() - 3_600_000); // app clock an hour behind: an expired lease must still be refused
      await expect(check()).rejects.toBeInstanceOf(JobLeaseLostError);
    } finally {
      vi.useRealTimers();
    }
  });
  it('is a no-op outside a job so request-time callers of the same provider code are unaffected', async () => {
    await expect(assertJobLease()).resolves.toBeUndefined();
  });
});
