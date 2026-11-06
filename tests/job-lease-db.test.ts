import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { db } from '../src/lib/db';
import { createRaid } from '../src/lib/campaigns';
import { config } from '../src/lib/config';
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
  let raidId: string;
  beforeAll(() => {
    assertTestDatabase();
    config.demo = false;
  });
  beforeEach(async () => {
    await truncateAll(db);
    const user = await db.user.create({ data: { xId: 'l-owner', handle: 'l', approved: true } });
    await db.xAccount.create({
      data: { userId: user.id, xUserId: 'l-owner', username: 'l', displayName: 'L' },
    });
    raidId = (
      await createRaid(user, {
        title: 'Lease campaign',
        description: 'A lease fixture campaign.',
        mint: MINT,
        symbol: 'SOL',
        name: 'Solana',
      })
    ).id;
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
  it('writes no raid or token error when the worker loses the lease while its handler is failing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await enqueue(
      'market',
      'market:lease:5',
      { mint: MINT, raidId },
      new Date(Date.now() - 60_000),
    );
    const stale = (await claimJob())!;
    const reclaimed: { lease: string | null }[] = [];
    // The pre-effect check passes, then the worker stalls past the lease, another worker reclaims, and the call fails.
    providerCalls.mockImplementation(async () => {
      await expireLease(stale.id);
      reclaimed.push((await claimJob())!);
      throw new Error('provider timed out after lease expiry');
    });
    await runJob(stale);
    expect(reclaimed).toHaveLength(1);
    expect(providerCalls).toHaveBeenCalledTimes(1);
    expect((await db.raid.findUniqueOrThrow({ where: { id: raidId } })).collectionError).toBeNull();
    expect((await db.token.findUniqueOrThrow({ where: { mint: MINT } })).marketError).toBeNull();
    const row = await db.job.findUniqueOrThrow({ where: { id: stale.id } });
    expect(row.lease).toBe(reclaimed[0].lease);
    expect(row.error).toBeNull();
  });
  it('still records raid and token errors for the worker that holds the lease', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await enqueue(
      'market',
      'market:lease:6',
      { mint: MINT, raidId },
      new Date(Date.now() - 60_000),
    );
    const job = (await claimJob())!;
    providerCalls.mockRejectedValue(new Error('provider down'));
    await runJob(job);
    expect((await db.raid.findUniqueOrThrow({ where: { id: raidId } })).collectionError).toBe(
      'provider down',
    );
    expect((await db.token.findUniqueOrThrow({ where: { mint: MINT } })).marketError).toBe(
      'provider down',
    );
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).error).toBe('provider down');
  });
  // AC67: process crashes after the external effect succeeded but before the local receipt was recorded.
  it('AC67: a refused stale worker repeats no effect and the reclaiming worker reconciles to one receipt', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await due('market:lease:7');
    const crashed = (await claimJob())!;
    // Worker A performs the provider effect and dies before finishJob/any local write.
    await runUnderJobLease(crashed, async () => {
      await assertJobLease();
      await providerCalls();
    });
    expect(providerCalls).toHaveBeenCalledTimes(1);
    expect((await db.job.findUniqueOrThrow({ where: { id: crashed.id } })).doneAt).toBeNull();
    expect((await db.token.findUniqueOrThrow({ where: { mint: MINT } })).marketAt).toBeNull();
    // Lease runs out; B reclaims. A (a zombie, not dead) wakes up and tries the job again: refused, nothing written.
    await expireLease(crashed.id);
    const reconciler = (await claimJob())!;
    await runJob(crashed);
    expect(providerCalls).toHaveBeenCalledTimes(1);
    const mid = await db.job.findUniqueOrThrow({ where: { id: crashed.id } });
    expect(mid).toMatchObject({ lease: reconciler.lease, doneAt: null, error: null });
    expect((await db.token.findUniqueOrThrow({ where: { mint: MINT } })).marketAt).toBeNull();
    // B reconciles: exactly one local receipt, job closed, never claimable again.
    await runJob(reconciler);
    expect(providerCalls).toHaveBeenCalledTimes(2);
    expect((await db.job.findUniqueOrThrow({ where: { id: crashed.id } })).doneAt).not.toBeNull();
    expect((await db.token.findUniqueOrThrow({ where: { mint: MINT } })).marketAt).not.toBeNull();
    expect(await claimJob()).toBeNull();
    await runJob(crashed); // a late zombie after completion is still refused
    expect(providerCalls).toHaveBeenCalledTimes(2);
  });
});
