import { readdirSync } from 'node:fs';
import path from 'node:path';
import { Prisma, type Job } from '@prisma/client';
import { trackingEnabled, config } from './config';
import { allocateRaidFunding } from './raid-allocation';
import { allocateUsdcRaid } from './studio-finance';
import { launchpadsAvailable } from './release';
import { finalizeTracking } from './tracking-review';
import { LOCKED_PHASES } from './tracking-domain';
import { processTrackingLookup } from './tracking-worker';
import { db } from './db';
import { enqueue, finishJob } from './queue';
import { collect, ingest, refresh, snapshot } from './collection';
import { fetchMarket } from './providers/market';
import { lookupPosts, ProviderError } from './providers/x';
import { financeLaunch, updateFinanceReadiness } from './rewards';
import { reconcileLaunch } from './pump-launch';
export async function step(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error) {
    console.error(
      JSON.stringify({ step: name, error: error instanceof Error ? error.message : String(error) }),
    );
  }
}
export async function assertSchemaCurrent(
  latest = readdirSync(path.join(process.cwd(), 'prisma', 'migrations'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .at(-1),
) {
  if (!latest) throw new Error('No migrations found.');
  const applied = await db.$queryRaw<
    unknown[]
  >`SELECT 1 FROM "_prisma_migrations" WHERE migration_name = ${latest} AND finished_at IS NOT NULL`;
  if (!applied.length) throw new Error(`Database schema is behind migration ${latest}.`);
}
export async function schedule(now = new Date()) {
  await step('finance-readiness', () => updateFinanceReadiness());
  await step('status-transitions', async () => {
    await db.raid.updateMany({
      where: { status: 'SCHEDULED', startsAt: { lte: now } },
      data: { status: 'ACTIVE' },
    });
    await db.raid.updateMany({
      where: { status: 'ACTIVE', trackingVersion: 2, endsAt: { lte: now } },
      data: {
        trackingPhase: 'FINALIZING',
        sinceId: null,
        nextToken: null,
        searchEndAt: null,
        pendingNewestId: null,
        finalRefreshed: false,
      },
    });
    await db.raid.updateMany({
      where: { status: 'ACTIVE', endsAt: { lte: now } },
      data: { status: 'ENDED' },
    });
  });
  await step('coverage-expired', async () => {
    // X recent search cannot reach past 7 days; record the dead end instead of leaving the Raid silently stuck.
    const expired = {
      status: 'ENDED',
      finalRefreshed: false,
      endsAt: { lt: new Date(+now - 7 * 86400000) },
    };
    await db.raid.updateMany({
      where: { ...expired, trackingVersion: 1 },
      data: {
        finalRefreshed: true,
        coverage: 'partial',
        collectionError: 'Final collection window expired.',
      },
    });
    await db.raid.updateMany({
      where: {
        ...expired,
        trackingVersion: 2,
        holdReason: null,
        trackingPhase: { notIn: [...LOCKED_PHASES] },
      },
      data: {
        holdReason: 'COVERAGE_EXPIRED',
        collectionError: 'Final search window expired; administrator decision required.',
      },
    });
  });
  await step('collect', async () => {
    const settings = await db.settings.upsert({
      where: { id: 'global' },
      create: {},
      update: {},
    });
    const raids = await db.raid.findMany({
      where: {
        hidden: false,
        creator: { suspended: false },
        OR: [
          { status: 'ACTIVE' },
          {
            status: 'ENDED',
            finalRefreshed: false,
            endsAt: { gte: new Date(Date.now() - 7 * 86400000) },
          },
        ],
      },
    });
    for (const raid of raids)
      await step(`collect:${raid.id}`, async () => {
        if (raid.trackingVersion === 2 && (!trackingEnabled() || raid.activeResultId)) return;
        if (settings.collectionEnabled)
          await enqueue('collect', `collect:${raid.id}:${Math.floor(Date.now() / 300000)}`, {
            raidId: raid.id,
            final: raid.endsAt <= now,
          });
        if (raid.status === 'ACTIVE') {
          if (raid.mint)
            await enqueue('market', `market:${raid.mint}:${Math.floor(Date.now() / 60000)}`, {
              mint: raid.mint,
            });
          await snapshot(
            raid.id,
            raid.coverage === 'complete' &&
              !!raid.observedAt &&
              Date.now() - +raid.observedAt < 600000,
          );
        }
      });
  });
  if (trackingEnabled()) {
    await step('finalize', async () => {
      const closing = await db.raid.findMany({
        where: {
          trackingVersion: 2,
          status: 'ENDED',
          trackingPhase: { notIn: ['APPROVED', ...LOCKED_PHASES] },
        },
        select: { id: true, studioVersion: true },
      });
      for (const raid of closing)
        await step(`settle:${raid.id}`, async () => {
          await finalizeTracking(raid.id);
          if (raid.studioVersion === 1) await allocateUsdcRaid(raid.id);
          else await allocateRaidFunding(raid.id);
        });
    });
    await step('allocate-retry', async () => {
      const approved = await db.raid.findMany({
        where: {
          trackingVersion: 2,
          status: 'ENDED',
          trackingPhase: 'APPROVED',
          fundingStatus: 'VERIFIED',
          OR: [{ studioVersion: 1 }, { mint: null, fundingLamports: { not: null } }],
        },
        select: { id: true, studioVersion: true },
      });
      for (const raid of approved)
        await step(`allocate:${raid.id}`, () =>
          raid.studioVersion === 1 ? allocateUsdcRaid(raid.id) : allocateRaidFunding(raid.id),
        );
    });
  }
  await step('launch-jobs', async () => {
    const pendingLaunches = await db.tokenLaunch.findMany({
      where: { status: 'SUBMITTED' },
      select: { id: true },
    });
    for (const launch of launchpadsAvailable ? pendingLaunches : [])
      await enqueue(
        'launch-reconcile',
        `launch-reconcile:${launch.id}:${Math.floor(Date.now() / 60000)}`,
        { launchId: launch.id },
      );
    const liveLaunches = await db.tokenLaunch.findMany({
      where: { status: { in: ['LIVE', 'PAUSED'] } },
      select: { id: true },
    });
    for (const launch of launchpadsAvailable ? liveLaunches : [])
      await enqueue('finance', `finance:${launch.id}:${Math.floor(Date.now() / 60000)}`, {
        launchId: launch.id,
        raidId: launch.id,
      });
  });
  await step('cleanup', async () => {
    await db.session.deleteMany({ where: { expiresAt: { lt: now } } });
    await db.walletChallenge.deleteMany({ where: { expiresAt: { lt: now } } });
    await db.oAuthAttempt.deleteMany({ where: { expiresAt: { lt: now } } });
    await db.rateLimit.deleteMany({ where: { expiresAt: { lt: now } } });
  });
  await step('retention', async () => {
    await db.post.updateMany({
      where: {
        createdAt: { lt: new Date(Date.now() - config.retentionDays * 86400000) },
        contentExpiredAt: null,
      },
      data: { text: '', normalized: '', contentExpiredAt: now },
    });
    await db.raidBriefPost.updateMany({
      where: { validatedAt: { lt: new Date(Date.now() - config.retentionDays * 86400000) } },
      data: { preview: Prisma.JsonNull },
    });
    await db.job.deleteMany({
      where: {
        OR: [
          { doneAt: { lt: new Date(Date.now() - 7 * 86400000) } },
          { failedAt: { lt: new Date(Date.now() - 30 * 86400000) } },
        ],
      },
    });
  });
  await step('reconcile', async () => {
    // Daily reconciliation for ended campaigns within the configured retention period.
    const ended = await db.raid.findMany({
      where: {
        status: 'ENDED',
        hidden: false,
        finalRefreshed: true,
        trackingVersion: 1,
        endsAt: { gte: new Date(Date.now() - config.retentionDays * 86400000) },
      },
    });
    for (const raid of ended)
      await enqueue('refresh', `reconcile:${raid.id}:${now.toISOString().slice(0, 10)}`, {
        raidId: raid.id,
        after: '',
        final: true,
      });
  });
}
async function clearCollectionError(raidId: string) {
  const remaining = await db.job.count({
    where: {
      doneAt: null,
      failedAt: null,
      error: { not: null },
      payload: { path: ['raidId'], equals: raidId },
    },
  });
  if (!remaining)
    await db.raid.updateMany({
      where: { id: raidId, trackingVersion: 2 },
      data: { collectionError: null },
    });
}
export async function runJob(job: Job) {
  const p = job.payload as {
    launchId: string;
    raidId: string;
    mint: string;
    after: string;
    coveredUntil?: string;
    final: boolean;
    postId: string;
    submissionId?: string;
  };
  try {
    if (job.kind === 'launch-reconcile') await reconcileLaunch(p.launchId);
    else if (job.kind === 'finance') await financeLaunch(p.launchId);
    else if (job.kind === 'collect') await collect(p.raidId, job.id);
    else if (job.kind === 'refresh')
      await refresh(p.raidId, p.after, p.final, p.coveredUntil, job.id, job.attempts);
    else if (job.kind === 'tracking-correction')
      await processTrackingLookup(p.raidId, p.postId, job.id, undefined, true);
    else if (job.kind === 'submission') {
      const raid = await db.raid.findUniqueOrThrow({
        where: { id: p.raidId },
        include: { creator: true },
      });
      if (raid.trackingVersion === 2) {
        await processTrackingLookup(p.raidId, p.postId, job.id, p.submissionId);
      } else {
        if (raid.hidden || raid.creator.suspended || raid.status !== 'ACTIVE')
          throw new Error('Raid is not accepting submissions.');
        const result = await lookupPosts([p.postId], p.raidId);
        await ingest(p.raidId, result.data || []);
        await snapshot(p.raidId, false);
      }
    } else if (job.kind === 'market') {
      const market = await fetchMarket(p.mint);
      await db.token.update({
        where: { mint: p.mint },
        data: {
          market: market ? JSON.parse(JSON.stringify(market)) : Prisma.DbNull,
          marketAt: new Date(),
          marketError: market ? null : 'No eligible market pair found.',
        },
      });
    }
    await finishJob(job);
    if (p.raidId && ['submission', 'tracking-correction'].includes(job.kind))
      await clearCollectionError(p.raidId);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Collection failed';
    if (p.raidId)
      await db.raid.updateMany({
        where: { id: p.raidId },
        data: {
          ...(['collect', 'refresh'].includes(job.kind) ? { coverage: 'partial' } : {}),
          collectionError: message,
        },
      });
    if (p.mint)
      await db.token.updateMany({ where: { mint: p.mint }, data: { marketError: message } });
    const { dead } = await finishJob(
      job,
      message,
      error instanceof ProviderError ? error.retryAfter : undefined,
      { refundAttempt: error instanceof ProviderError && error.deferred },
    );
    if (dead) {
      if (job.kind === 'submission' && p.submissionId)
        await db.postSubmission.updateMany({
          where: { id: p.submissionId, status: 'QUEUED' },
          data: { status: 'EXCLUDED', reasonCode: 'LOOKUP_FAILED' },
        });
      if (p.raidId && ['submission', 'tracking-correction'].includes(job.kind))
        await clearCollectionError(p.raidId);
    }
    console.error(JSON.stringify({ job: job.id, kind: job.kind, error: message }));
  }
}
