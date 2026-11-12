import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ user: vi.fn(), origin: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('../src/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/auth')>()),
  checkOrigin: mocks.origin,
  requireUser: mocks.user,
}));
import { db } from '../src/lib/db';
import { config } from '../src/lib/config';
import { POST } from '../src/app/api/admin/[action]/route';
import { lookupPosts, ProviderError } from '../src/lib/providers/x';
import { claimJob, JOB_MAX_ATTEMPTS } from '../src/lib/queue';
import { runJob } from '../src/lib/worker-jobs';
import { createRaid } from '../src/lib/campaigns';
import { enqueueDue } from './helpers/queue';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
import { routeContext, routeRequest } from './helpers/route';

/**
 * DEC-2026-11-07-01 (c): an X header timeout counts as an attempt, a persistent timeout stops spending, and an admin
 * retry can reset it. A timed-out request may still have been served and billed, so each one keeps its reservation;
 * if the retry were also refunded (deferred), reservations would pile up to the budget cutoff.
 */
const suite = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const headerTimeout = () => new DOMException('The operation timed out.', 'TimeoutError');

suite('X header timeout attempts', () => {
  beforeAll(() => assertTestDatabase());
  beforeEach(async () => {
    await truncateAll(db);
    await db.settings.create({ data: { id: 'global', collectionEnabled: true } });
    vi.stubEnv('X_BEARER_TOKEN', 'fixture-bearer');
    config.demo = false;
    config.liveApproved = true;
    mocks.origin.mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const setup = async () => {
    const owner = await db.user.create({ data: { xId: 't-owner', handle: 't', approved: true } });
    await db.xAccount.create({
      data: { userId: owner.id, xUserId: 't-owner', username: 't', displayName: 'T' },
    });
    const raid = await createRaid(owner, {
      title: 'Timeout campaign',
      description: 'A timeout fixture campaign.',
      mint: 'So11111111111111111111111111111111111111112',
      symbol: 'SOL',
      name: 'Solana',
    });
    await db.raid.update({ where: { id: raid.id }, data: { status: 'ACTIVE' } });
    const fetcher = vi.fn().mockRejectedValue(headerTimeout());
    vi.stubGlobal('fetch', fetcher);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const job = await enqueueDue('submission', 'submission:t:1', { raidId: raid.id, postId: '1' });
    return { raid, job, fetcher };
  };

  it('reports a header timeout as a counted (non-deferred) failure and keeps the reservation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(headerTimeout()));
    const failure = await lookupPosts(['1']).catch((error) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    expect(failure).toMatchObject({ deferred: false, retryAfter: 0 }); // 0: finishJob's exponential backoff applies;
    expect(failure.message).toContain('timed out');
    const usage = await db.providerUsage.findFirstOrThrow({ where: { provider: 'x' } });
    expect(usage.reservedCents).toBeGreaterThan(0);
    expect(usage.reason).toContain('reservation kept');
  });

  it('keeps an ordinary transport failure deferred and settles it to nothing billable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const failure = await lookupPosts(['1']).catch((error) => error);
    expect(failure).toMatchObject({ deferred: true });
    const usage = await db.providerUsage.findFirstOrThrow({ where: { provider: 'x' } });
    expect(usage.reservedCents).toBe(0);
  });

  it('backs off exponentially between timed-out attempts instead of a fixed delay', async () => {
    const { job } = await setup();
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      await db.job.update({
        where: { id: job.id },
        data: { runAt: new Date(Date.now() - 60_000) },
      });
      await runJob((await claimJob())!);
      const row = await db.job.findUniqueOrThrow({ where: { id: job.id } });
      delays.push(Math.round((+row.runAt - Date.now()) / 1000));
    }
    // finishJob's default is 30 * 2^attempt seconds (60, 120, 240), not a fixed 60.
    expect(delays[1]).toBeGreaterThan(100);
    expect(delays[2]).toBeGreaterThan(200);
  });

  it('blocks the endpoint once a job dead-letters on timeouts, so a NEW job neither fetches nor reserves, until admin retry', async () => {
    const { raid, job, fetcher } = await setup();
    for (let attempt = 1; attempt <= JOB_MAX_ATTEMPTS; attempt++) {
      await db.job.update({
        where: { id: job.id },
        data: { runAt: new Date(Date.now() - 60_000) },
      });
      await runJob((await claimJob())!);
    }
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).failedAt).not.toBeNull();
    const callsAtStop = fetcher.mock.calls.length;
    const reservationsAtStop = await db.providerUsage.count({ where: { provider: 'x' } });

    // A different time bucket enqueues a different key; it must not be able to spend again.
    const fresh = await enqueueDue('submission', 'submission:t:2', {
      raidId: raid.id,
      postId: '2',
    });
    await runJob((await claimJob())!);
    expect(fetcher.mock.calls.length).toBe(callsAtStop);
    expect(await db.providerUsage.count({ where: { provider: 'x' } })).toBe(reservationsAtStop);
    const parked = await db.job.findUniqueOrThrow({ where: { id: fresh.id } });
    expect(parked.failedAt).toBeNull();
    expect(parked.attempts).toBe(0); // refused before any call: not charged as an attempt
    expect(+parked.runAt - Date.now()).toBeLessThan(2 * 3600_000); // re-checks soon, not years away

    // Administrator retry of the dead-lettered job clears the block.
    const admin = await db.user.create({ data: { handle: 'admin', role: 'ADMIN' } });
    mocks.user.mockResolvedValue({ id: admin.id, role: 'ADMIN' });
    const retried = await POST(
      routeRequest('http://localhost:3000/api/admin/retry', {
        body: { id: job.id, reason: 'X timeouts cleared' },
      }),
      routeContext({ action: 'retry' }),
    );
    expect(retried.status).toBe(200);
    await db.job.update({
      where: { id: fresh.id },
      data: { runAt: new Date(Date.now() - 60_000) },
    });
    await db.job.update({
      where: { id: job.id },
      data: { runAt: new Date(Date.now() + 3600_000) },
    });
    await runJob((await claimJob())!);
    expect(fetcher.mock.calls.length).toBe(callsAtStop + 1);
  });

  it('dead-letters a persistently timing-out job at the attempt limit, stops spending, and admin retry resets it', async () => {
    const owner = await db.user.create({ data: { xId: 't-owner', handle: 't', approved: true } });
    await db.xAccount.create({
      data: { userId: owner.id, xUserId: 't-owner', username: 't', displayName: 'T' },
    });
    const raid = await createRaid(owner, {
      title: 'Timeout campaign',
      description: 'A timeout fixture campaign.',
      mint: 'So11111111111111111111111111111111111111112',
      symbol: 'SOL',
      name: 'Solana',
    });
    await db.raid.update({ where: { id: raid.id }, data: { status: 'ACTIVE' } });
    const fetcher = vi.fn().mockRejectedValue(headerTimeout());
    vi.stubGlobal('fetch', fetcher);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const job = await enqueueDue('submission', 'submission:t:1', { raidId: raid.id, postId: '1' });
    const due = () =>
      db.job.update({ where: { id: job.id }, data: { runAt: new Date(Date.now() - 60_000) } });

    for (let attempt = 1; attempt <= JOB_MAX_ATTEMPTS; attempt++) {
      await due();
      const claimed = await claimJob();
      expect(claimed?.attempts).toBe(attempt);
      await runJob(claimed!);
    }
    const final = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(final.attempts).toBe(JOB_MAX_ATTEMPTS);
    expect(final.failedAt).not.toBeNull();

    // Stopped: nothing is claimable and the provider is not called again.
    const callsAtStop = fetcher.mock.calls.length;
    const reservationsAtStop = await db.providerUsage.count({ where: { provider: 'x' } });
    await due();
    expect(await claimJob()).toBeNull();
    expect(fetcher.mock.calls.length).toBe(callsAtStop);
    expect(reservationsAtStop).toBe(JOB_MAX_ATTEMPTS);

    // An administrator retry resets the attempts and the job can run (and be counted) again.
    const admin = await db.user.create({ data: { handle: 'admin', role: 'ADMIN' } });
    mocks.user.mockResolvedValue({ id: admin.id, role: 'ADMIN' });
    const retried = await POST(
      routeRequest('http://localhost:3000/api/admin/retry', {
        body: { id: job.id, reason: 'X timeouts cleared' },
      }),
      routeContext({ action: 'retry' }),
    );
    expect(retried.status).toBe(200);
    const claimed = await claimJob();
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.attempts).toBe(1);
    await runJob(claimed!);
    expect(fetcher.mock.calls.length).toBe(callsAtStop + 1);
  });
});
