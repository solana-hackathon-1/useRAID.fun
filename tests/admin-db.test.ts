import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ user: vi.fn(), origin: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('../src/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/auth')>()),
  checkOrigin: mocks.origin,
  requireUser: mocks.user,
}));
import { db } from '../src/lib/db';
import { POST } from '../src/app/api/admin/[action]/route';
import { enqueue } from '../src/lib/queue';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
import { routeContext, routeRequest } from './helpers/route';
const suite = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
suite('admin job retry', () => {
  let adminId: string;
  const retry = (id?: string) =>
    POST(
      routeRequest('http://localhost:3000/api/admin/retry', { body: { id, reason: 'retry' } }),
      routeContext({ action: 'retry' }),
    );
  beforeAll(() => assertTestDatabase());
  beforeEach(async () => {
    await truncateAll(db);
    adminId = (await db.user.create({ data: { handle: 'admin', role: 'ADMIN' } })).id;
    mocks.user.mockResolvedValue({ id: adminId, role: 'ADMIN' });
    mocks.origin.mockImplementation(() => {});
  });
  afterAll(() => db.$disconnect());
  const failed = async (key: string, data: Record<string, unknown> = {}) => {
    const job = await enqueue('collect', key, { raidId: 'r' });
    return db.job.update({
      where: { id: job.id },
      data: { error: 'boom', attempts: 8, failedAt: new Date(), ...data },
    });
  };
  it('resets a failed idle job, clears dead-lettering and audits it', async () => {
    const job = await failed('retry-a');
    expect((await retry(job.id)).status).toBe(200);
    expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      attempts: 0,
      error: null,
      failedAt: null,
      lockedAt: null,
      lease: null,
      doneAt: null,
    });
    expect(await db.moderationEvent.count({ where: { action: 'retry', targetId: job.id } })).toBe(
      1,
    );
  });
  it('refuses finished, running and unknown jobs', async () => {
    const done = await failed('retry-b', { doneAt: new Date(), failedAt: null });
    expect((await retry(done.id)).status).toBe(409);
    expect((await db.job.findUniqueOrThrow({ where: { id: done.id } })).error).toBe('boom');
    const running = await failed('retry-c', { lockedAt: new Date(), lease: 'live' });
    expect((await retry(running.id)).status).toBe(409);
    expect((await db.job.findUniqueOrThrow({ where: { id: running.id } })).lease).toBe('live');
    expect((await retry('missing')).status).toBe(409);
    expect((await retry()).status).toBe(400);
  });
  it('retries a job whose lock went stale', async () => {
    const job = await failed('retry-d', {
      lockedAt: new Date(Date.now() - 11 * 60000),
      lease: 'zombie',
    });
    expect((await retry(job.id)).status).toBe(200);
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).lease).toBeNull();
  });
  it('revives a dead-lettered submission with its job', async () => {
    const user = await db.user.create({ data: { handle: 'u', xId: 'u' } });
    const raid = await db.raid.create({
      data: {
        creatorId: user.id,
        tag: 'raid_x',
        title: 'T',
        description: 'D',
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 1000),
        trackingVersion: 2,
      },
    });
    const enrollment = await db.raidEnrollment.create({
      data: { raidId: raid.id, userId: user.id, xId: 'u', walletAddress: 'w' },
    });
    const sub = await db.postSubmission.create({
      data: {
        raidId: raid.id,
        enrollmentId: enrollment.id,
        postId: '5',
        status: 'EXCLUDED',
        reasonCode: 'LOOKUP_FAILED',
      },
    });
    const job = await enqueue('submission', 'sub-r', { raidId: raid.id, submissionId: sub.id });
    await db.job.update({
      where: { id: job.id },
      data: { error: 'x', attempts: 8, failedAt: new Date() },
    });
    expect((await retry(job.id)).status).toBe(200);
    expect(await db.postSubmission.findUniqueOrThrow({ where: { id: sub.id } })).toMatchObject({
      status: 'QUEUED',
      reasonCode: null,
    });
  });
  it('lets an administrator suspend another administrator but never themselves', async () => {
    const other = await db.user.create({ data: { handle: 'other', xId: 'other', role: 'ADMIN' } });
    await db.session.create({
      data: { tokenHash: 'other-session', userId: other.id, expiresAt: new Date(Date.now() + 1e6) },
    });
    const suspend = (id: string) =>
      POST(
        routeRequest('http://localhost:3000/api/admin/creator', {
          body: { id, suspended: true, reason: 'review' },
        }),
        routeContext({ action: 'creator' }),
      );
    expect((await suspend(adminId)).status).toBe(400);
    expect((await db.user.findUniqueOrThrow({ where: { id: adminId } })).suspended).toBe(false);
    expect((await suspend(other.id)).status).toBe(200);
    expect((await db.user.findUniqueOrThrow({ where: { id: other.id } })).suspended).toBe(true);
    expect(await db.session.count({ where: { userId: other.id } })).toBe(0);
  });
});
