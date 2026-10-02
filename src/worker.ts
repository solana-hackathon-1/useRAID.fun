import 'dotenv/config';
import { trackingEnabled } from './lib/config';
import { allocateRaidFunding } from './lib/raid-allocation';
import { allocateUsdcRaid } from './lib/studio-finance';
import { allocateLaunchCampaign } from './lib/meteora/campaigns';
import { financeMeteoraLaunch } from './lib/meteora/worker';
import { nextLaunchStep } from './lib/meteora/launch';
import { meteoraNetwork } from './lib/meteora/config';
import { launchpadsAvailable } from './lib/release';
import { finalizeTracking } from './lib/tracking-review';
import { processTrackingLookup } from './lib/tracking-worker';
import { Prisma } from '@prisma/client';
import { db } from './lib/db';
import { config } from './lib/config';
import { claimJob, enqueue, finishJob } from './lib/queue';
import { collect, ingest, refresh, snapshot } from './lib/collection';
import { fetchMarket } from './lib/providers/market';
import { lookupPosts, ProviderError } from './lib/providers/x';
import { financeLaunch, updateFinanceReadiness } from './lib/rewards';
import { reconcileLaunch } from './lib/pump-launch';
let stopping = false;
process.on('SIGTERM', () => {
  stopping = true;
});
process.on('SIGINT', () => {
  stopping = true;
});
async function schedule() {
  const now = new Date();
  await updateFinanceReadiness();
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
  for (const raid of raids) {
    if (raid.trackingVersion === 2 && (!trackingEnabled() || raid.activeResultId)) continue;
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
        raid.coverage === 'complete' && !!raid.observedAt && Date.now() - +raid.observedAt < 600000,
      );
    }
  }
  if (trackingEnabled()) {
    const closing = await db.raid.findMany({
      where: {
        trackingVersion: 2,
        status: 'ENDED',
        trackingPhase: { notIn: ['ALLOCATED', 'HELD', 'HELD_RESOLVED'] },
      },
    });
    for (const raid of closing) {
      await finalizeTracking(raid.id);
      if (raid.fundingAsset === 'LAUNCH') await allocateLaunchCampaign(raid.id);
      else if (raid.studioVersion === 1) await allocateUsdcRaid(raid.id);
      else await allocateRaidFunding(raid.id);
    }
  }
  const pendingLaunches = await db.tokenLaunch.findMany({
    where: { provider: 'PUMP', status: 'SUBMITTED' },
    select: { id: true },
  });
  for (const launch of launchpadsAvailable ? pendingLaunches : [])
    await enqueue(
      'launch-reconcile',
      `launch-reconcile:${launch.id}:${Math.floor(Date.now() / 60000)}`,
      { launchId: launch.id },
    );
  const liveLaunches = await db.tokenLaunch.findMany({
    where: { provider: 'PUMP', status: { in: ['LIVE', 'PAUSED'] } },
    select: { id: true },
  });
  for (const launch of launchpadsAvailable ? liveLaunches : [])
    await enqueue('finance', `finance:${launch.id}:${Math.floor(Date.now() / 60000)}`, {
      launchId: launch.id,
      raidId: launch.id,
    });
  const meteoraLaunches = await db.tokenLaunch.findMany({
    where: { provider: 'METEORA', network: meteoraNetwork(), status: { in: ['PREPARED', 'SUBMITTED', 'LIVE', 'PAUSED'] } },
    select: { id: true, userId: true, status: true },
  });
  for (const launch of meteoraLaunches) {
    if (['PREPARED', 'SUBMITTED'].includes(launch.status)) {
      const submitted = await db.launchStep.count({ where: { launchId: launch.id, kind: 'SETUP', status: { in: ['SUBMITTED', 'CONFIRMED'] } } });
      if (submitted) await enqueue('meteora-reconcile', `meteora-reconcile:${launch.id}:${Math.floor(Date.now()/60000)}`, { launchId: launch.id, raidId: `meteora:${launch.id}`, userId: launch.userId });
    } else await enqueue('meteora-finance', `meteora-finance:${launch.id}:${Math.floor(Date.now()/60000)}`, { launchId: launch.id, raidId: `meteora:${launch.id}` });
  }
  await db.session.deleteMany({ where: { expiresAt: { lt: now } } });
  await db.walletChallenge.deleteMany({ where: { expiresAt: { lt: now } } });
  await db.oAuthAttempt.deleteMany({ where: { expiresAt: { lt: now } } });
  await db.rateLimit.deleteMany({ where: { expiresAt: { lt: now } } });
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
  await db.job.deleteMany({ where: { doneAt: { lt: new Date(Date.now() - 7 * 86400000) } } });
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
}
async function main() {
  if (config.demo) throw new Error('Worker cannot run in demo mode.');
  let scheduled = 0;
  while (!stopping) {
    try {
      if (Date.now() - scheduled > 60000) {
        await schedule();
        scheduled = Date.now();
      }
      const job = await claimJob();
      if (!job) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      const p = job.payload as {
        launchId: string;
        raidId: string;
        mint: string;
        after: string;
        coveredUntil?: string;
        final: boolean;
        postId: string;
        submissionId?: string;
        userId?: string;
      };
      try {
        if (job.kind === 'meteora-reconcile') await nextLaunchStep(p.launchId, p.userId!);
        else if (job.kind === 'meteora-finance') await financeMeteoraLaunch(p.launchId);
        else if (job.kind === 'launch-reconcile') await reconcileLaunch(p.launchId);
        else if (job.kind === 'finance') await financeLaunch(p.launchId);
        else if (job.kind === 'collect') await collect(p.raidId, job.id);
        else if (job.kind === 'refresh')
          await refresh(p.raidId, p.after, p.final, p.coveredUntil, job.id);
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
        if (p.raidId && ['submission', 'tracking-correction'].includes(job.kind)) {
          const remaining = await db.job.count({
            where: {
              doneAt: null,
              error: { not: null },
              payload: { path: ['raidId'], equals: p.raidId },
            },
          });
          if (!remaining)
            await db.raid.updateMany({
              where: { id: p.raidId, trackingVersion: 2 },
              data: { collectionError: null },
            });
        }
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
        await finishJob(
          job,
          message,
          error instanceof ProviderError ? error.retryAfter : undefined,
        );
        console.error(JSON.stringify({ job: job.id, kind: job.kind, error: message }));
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Worker failed');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  await db.$disconnect();
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
