import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { db } from '../src/lib/db';
import { createRaid } from '../src/lib/campaigns';
import { config } from '../src/lib/config';
import { assertSchemaCurrent, runJob, schedule, step } from '../src/lib/worker-jobs';
import { claimJob, enqueue } from '../src/lib/queue';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
const suite = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
suite('worker jobs module', () => {
  let raidId: string;
  beforeAll(() => {
    assertTestDatabase();
    config.demo = false;
  });
  beforeEach(async () => {
    await truncateAll(db);
    const user = await db.user.create({ data: { xId: 'w-owner', handle: 'w', approved: true } });
    await db.xAccount.create({
      data: { userId: user.id, xUserId: 'w-owner', username: 'w', displayName: 'W' },
    });
    raidId = (
      await createRaid(user, {
        title: 'Worker campaign',
        description: 'A worker fixture campaign.',
        mint: 'So11111111111111111111111111111111111111112',
        symbol: 'SOL',
        name: 'Solana',
      })
    ).id;
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db.$disconnect();
  });
  it('moves due SCHEDULED raids to ACTIVE', async () => {
    const now = new Date();
    await db.raid.update({
      where: { id: raidId },
      data: {
        status: 'SCHEDULED',
        startsAt: new Date(+now - 1000),
        endsAt: new Date(+now + 86400000),
      },
    });
    await schedule(now);
    expect((await db.raid.findUniqueOrThrow({ where: { id: raidId } })).status).toBe('ACTIVE');
  });
  it('ends ACTIVE v2 raids past endsAt and resets their finalization cursors', async () => {
    vi.stubEnv('X_TRACKING_V2_ENABLED', 'false');
    const now = new Date();
    await db.raid.update({
      where: { id: raidId },
      data: {
        status: 'ACTIVE',
        trackingVersion: 2,
        startsAt: new Date(+now - 86400000),
        endsAt: new Date(+now - 1000),
        sinceId: '1',
        nextToken: 't',
        pendingNewestId: '2',
        finalRefreshed: true,
      },
    });
    await schedule(now);
    const raid = await db.raid.findUniqueOrThrow({ where: { id: raidId } });
    expect(raid).toMatchObject({
      status: 'ENDED',
      trackingPhase: 'FINALIZING',
      sinceId: null,
      nextToken: null,
      searchEndAt: null,
      pendingNewestId: null,
      finalRefreshed: false,
    });
  });
  it('enqueues no launch or finance jobs while launchpads are unavailable', async () => {
    await db.token.upsert({
      where: { mint: 'So11111111111111111111111111111111111111112' },
      create: { mint: 'So11111111111111111111111111111111111111112', name: 'S', symbol: 'S' },
      update: {},
    });
    await schedule();
    expect(await db.job.count({ where: { kind: { in: ['launch-reconcile', 'finance'] } } })).toBe(
      0,
    );
  });
  it('finishes an unknown job kind without throwing', async () => {
    await enqueue('mystery', 'mystery:1', {});
    const job = (await claimJob())!;
    await expect(runJob(job)).resolves.toBeUndefined();
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).doneAt).not.toBeNull();
  });
  it('records a failing job and keeps going', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await enqueue('collect', 'collect:missing', { raidId: 'missing-raid' });
    const job = (await claimJob())!;
    await expect(runJob(job)).resolves.toBeUndefined();
    const row = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.error).toBeTruthy();
    expect(row.doneAt).toBeNull();
  });
  it('assertSchemaCurrent passes on the migrated database and rejects a newer migration', async () => {
    await expect(assertSchemaCurrent()).resolves.toBeUndefined();
    await expect(assertSchemaCurrent('299901010001_future')).rejects.toThrow(/behind/);
  });
  it('step() logs and swallows errors', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      step('x', async () => {
        throw new Error('boom');
      }),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(JSON.stringify({ step: 'x', error: 'boom' }));
  });
});
