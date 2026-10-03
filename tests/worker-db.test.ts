import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import * as trackingReview from '../src/lib/tracking-review';
import * as studioFinance from '../src/lib/studio-finance';
import * as raidAllocation from '../src/lib/raid-allocation';
import { db } from '../src/lib/db';
import { createRaid } from '../src/lib/campaigns';
import { config } from '../src/lib/config';
import { assertSchemaCurrent, runJob, schedule, step } from '../src/lib/worker-jobs';
import { claimJob, enqueue } from '../src/lib/queue';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
const gate = vi.hoisted(() => ({ on: false }));
vi.mock('../src/lib/release', () => ({
  get launchpadsAvailable() {
    return gate.on;
  },
  assertLaunchpadsAvailable: () => {},
}));
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
  describe('launch jobs', () => {
    const launchJobs = async () =>
      (await db.job.findMany({ where: { kind: { in: ['launch-reconcile', 'finance'] } } })).map(
        (j) => ({
          kind: j.kind,
          key: j.key,
          launchId: (j.payload as { launchId: string }).launchId,
        }),
      );
    const launch = async (status: string, data: Record<string, unknown> = {}) => {
      const owner = await db.user.findFirstOrThrow();
      return db.tokenLaunch.create({
        data: {
          userId: owner.id,
          mint: `mint-${Math.random().toString(36).slice(2)}`,
          name: 'N',
          symbol: 'S',
          description: 'd',
          metadataUri: 'u',
          imageUri: 'i',
          feeAddress: `fee-${Math.random().toString(36).slice(2)}`,
          feeSecret: 'x',
          mintSecret: 'y',
          status,
          ...data,
        },
      });
    };
    const signed = (launchId: string) =>
      db.financialTx.create({
        data: {
          key: `k-${launchId}`,
          launchId,
          kind: 'CLAIM',
          raw: 'r',
          signature: `s-${launchId}`,
          blockhash: 'b',
          lastValidBlockHeight: 1,
        },
      });
    afterEach(() => {
      gate.on = false;
    });
    it('reconciles recorded work while launchpads are unavailable and nothing else', async () => {
      const submitted = await launch('SUBMITTED', { signature: 'sig-submitted' });
      const prepared = await launch('PREPARED', { preparedHash: 'h' });
      const unprepared = await launch('PREPARED');
      const liveSigned = await launch('LIVE');
      await signed(liveSigned.id);
      const pausedSigned = await launch('PAUSED');
      await signed(pausedSigned.id);
      await launch('LIVE');
      await launch('PAUSED');
      await schedule();
      const jobs = await launchJobs();
      expect(
        jobs
          .filter((j) => j.kind === 'launch-reconcile')
          .map((j) => j.launchId)
          .sort(),
      ).toEqual([submitted.id, prepared.id].sort());
      expect(
        jobs
          .filter((j) => j.kind === 'finance')
          .map((j) => j.launchId)
          .sort(),
      ).toEqual([liveSigned.id, pausedSigned.id].sort());
      expect(jobs.some((j) => j.launchId === unprepared.id)).toBe(false);
    });
    it('ignores a prepared launch that has been idle for a day', async () => {
      const old = await launch('PREPARED', { preparedHash: 'h' });
      await db.$executeRaw`UPDATE "TokenLaunch" SET "updatedAt" = NOW() - INTERVAL '2 days' WHERE id = ${old.id}`;
      await schedule();
      expect(await launchJobs()).toEqual([]);
    });
    it('polls busy launches every minute and idle ones hourly once launchpads are on', async () => {
      gate.on = true;
      const idle = await launch('LIVE');
      const busy = await launch('LIVE');
      const busyRaid = await db.raid.create({
        data: {
          tag: 'raid_busy_launch',
          title: 'Busy',
          description: '',
          creatorId: (await db.user.findFirstOrThrow()).id,
          tokenLaunchId: busy.id,
          status: 'ACTIVE',
          startsAt: new Date(Date.now() - 1000),
          endsAt: new Date(Date.now() + 3600000),
        },
      });
      await db.tokenLaunch.update({ where: { id: busy.id }, data: { raidId: busyRaid.id } });
      const pausedIdle = await launch('PAUSED');
      const pausedSigned = await launch('PAUSED');
      await signed(pausedSigned.id);
      await schedule();
      const finance = (await launchJobs()).filter((j) => j.kind === 'finance');
      expect(finance.find((j) => j.launchId === idle.id)!.key).toContain(':h');
      expect(finance.find((j) => j.launchId === busy.id)!.key).not.toContain(':h');
      expect(finance.find((j) => j.launchId === pausedSigned.id)!.key).not.toContain(':h');
      expect(finance.some((j) => j.launchId === pausedIdle.id)).toBe(false);
    });
    it('ranks finance work below collection and keeps the launch id as the serialising key', async () => {
      const finance = await enqueue('finance', 'finance:l1:1', { launchId: 'l1', raidId: 'l1' });
      const reconcile = await enqueue('launch-reconcile', 'launch-reconcile:l1:1', {
        launchId: 'l1',
      });
      const collect = await enqueue('collect', 'collect:r1:1', { raidId: 'r1' });
      expect(finance.priority).toBe(5);
      expect(reconcile.priority).toBe(5);
      expect(collect.priority).toBe(10);
      expect((await claimJob())!.id).toBe(collect.id);
    });
    it('does not write a collection error onto a raid when a finance job fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.stubEnv('OPERATOR_SECRET_KEY', 'not-a-key');
      vi.stubEnv('SOLANA_RPC_URL', 'https://rpc.example');
      const l = await launch('LIVE');
      await db.raid.update({ where: { id: raidId }, data: { collectionError: null } });
      await enqueue('finance', 'finance:fail:1', { launchId: l.id, raidId });
      const job = (await claimJob())!;
      await runJob(job);
      expect(
        (await db.raid.findUniqueOrThrow({ where: { id: raidId } })).collectionError,
      ).toBeNull();
      expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).error).not.toBeNull();
      vi.unstubAllEnvs();
    });
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
  describe('queue scheduling', () => {
    let creatorId: string;
    const ended = (tag: string, data: Record<string, unknown> = {}) =>
      db.raid.create({
        data: {
          creatorId,
          tag,
          title: tag,
          description: 'Scheduler fixture',
          status: 'ENDED',
          trackingVersion: 2,
          startsAt: new Date(Date.now() - 172800000),
          endsAt: new Date(Date.now() - 86400000),
          finalRefreshed: true,
          ...data,
        },
      });
    beforeEach(async () => {
      creatorId = (await db.user.findFirstOrThrow()).id;
      await db.raid.deleteMany();
      vi.stubEnv('X_TRACKING_V2_ENABLED', 'true');
    });
    afterEach(() => vi.restoreAllMocks());
    it('does not enqueue collect jobs while collection is paused', async () => {
      await db.raid.create({
        data: {
          creatorId,
          tag: 'paused_raid',
          title: 'Paused',
          description: 'Scheduler fixture',
          status: 'ACTIVE',
          trackingVersion: 1,
          startsAt: new Date(Date.now() - 3600000),
          endsAt: new Date(Date.now() + 3600000),
        },
      });
      await db.settings.upsert({
        where: { id: 'global' },
        create: { collectionEnabled: false },
        update: { collectionEnabled: false },
      });
      await schedule();
      expect(await db.job.count({ where: { kind: 'collect' } })).toBe(0);
      await db.settings.update({ where: { id: 'global' }, data: { collectionEnabled: true } });
      await schedule();
      expect(await db.job.count({ where: { kind: 'collect' } })).toBe(1);
    });
    it('keeps settling other raids when one raid throws', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const a = await ended('iso_a', { trackingPhase: 'FINALIZING' });
      const b = await ended('iso_b', { trackingPhase: 'FINALIZING' });
      const finalize = vi
        .spyOn(trackingReview, 'finalizeTracking')
        .mockImplementation(async (id) => {
          if (id === a.id) throw new Error('boom');
          return undefined;
        });
      await expect(schedule()).resolves.toBeUndefined();
      expect(finalize.mock.calls.map((call) => call[0]).sort()).toEqual([a.id, b.id].sort());
    });
    it('does not re-finalize APPROVED raids and only retries payable allocations', async () => {
      const token = await ended('appr_token', {
        trackingPhase: 'APPROVED',
        mint: 'So11111111111111111111111111111111111111112',
      });
      const unfunded = await ended('appr_unfunded', { trackingPhase: 'APPROVED' });
      const studio = await ended('appr_studio', {
        trackingPhase: 'APPROVED',
        studioVersion: 1,
        fundingStatus: 'VERIFIED',
      });
      const sol = await ended('appr_sol', {
        trackingPhase: 'APPROVED',
        fundingStatus: 'VERIFIED',
        fundingLamports: '1000',
      });
      const finalize = vi.spyOn(trackingReview, 'finalizeTracking').mockResolvedValue(undefined);
      const usdc = vi.spyOn(studioFinance, 'allocateUsdcRaid').mockResolvedValue(undefined);
      const lamports = vi.spyOn(raidAllocation, 'allocateRaidFunding').mockResolvedValue(undefined);
      await schedule();
      await schedule();
      expect(finalize).not.toHaveBeenCalled();
      expect(usdc.mock.calls.map((call) => call[0])).toEqual([studio.id, studio.id]);
      expect(lamports.mock.calls.map((call) => call[0])).toEqual([sol.id, sol.id]);
      expect(
        [token.id, unfunded.id].some((id) =>
          [...usdc.mock.calls, ...lamports.mock.calls].some((call) => call[0] === id),
        ),
      ).toBe(false);
    });
    it('expires dead-lettered jobs after thirty days', async () => {
      const make = (key: string, failedAt: Date) =>
        db.job.create({
          data: { kind: 'test', key, payload: {}, error: 'x', attempts: 8, failedAt },
        });
      await make('dead-old', new Date(Date.now() - 31 * 86400000));
      await make('dead-new', new Date(Date.now() - 86400000));
      await schedule();
      expect((await db.job.findMany()).map((job) => job.key)).toEqual(['dead-new']);
    });
  });
});
