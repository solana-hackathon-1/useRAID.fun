import { readdirSync } from 'node:fs';
import path from 'node:path';
import { Prisma, type Job } from '@prisma/client';
import { trackingEnabled, config } from './config';
import { allocateRaidFunding } from './raid-allocation';
import { allocateUsdcRaid } from './studio-finance';
import { launchpadsAvailable } from './release';
import { finalizeTracking, measureEnd } from './tracking-review';
import { LOCKED_PHASES } from './tracking-domain';
import { observedImpressions } from './raid-progress';
import { processTrackingLookup } from './tracking-worker';
import { db } from './db';
import { enqueue, finishJob } from './queue';
import { collect, ingest, refresh, snapshot } from './collection';
import { fetchMarket } from './providers/market';
import { lookupPosts, ProviderError } from './providers/x';
import { financeLaunch, updateFinanceReadiness } from './rewards';
import { reconcileLaunch } from './pump-launch';
import { allocateLaunchCampaign } from './meteora/campaigns';
import { meteoraNetwork } from './meteora/config';
import { nextLaunchStep } from './meteora/launch';
import { financeMeteoraLaunch } from './meteora/worker';
import { usdcSettings } from './usdc';
import { reconcileUsdc, reconciliationJson } from './usdc-reconcile';
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
let reconciledHour = 0;
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
        searchQuery: null,
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
    await step('measure', async () => {
      const measuring = await db.raid.findMany({
        where: {
          trackingVersion: 2,
          status: 'ENDED',
          activeResultId: null,
          measureUntil: { not: null },
          hidden: false,
          creator: { suspended: false },
        },
        select: { id: true, measureUntil: true, endsAt: true, impressionTarget: true },
      });
      for (const raid of measuring)
        await step(`measure:${raid.id}`, async () => {
          const posts = await db.post.findMany({
            where: { raidId: raid.id, qualification: 'QUALIFIED' },
          });
          const hour = Math.floor(+now / 3600000);
          if (!posts.length || measureEnd(raid, observedImpressions(posts).total) <= raid.endsAt)
            return;
          const payload = { raidId: raid.id, after: '', final: true };
          if (raid.measureUntil! > now)
            await enqueue('refresh', `measure:${raid.id}:${hour}`, payload);
          else if (posts.some((p) => p.observedAt < raid.measureUntil!))
            await enqueue('refresh', `measure-final:${raid.id}:${hour}`, payload);
        });
    });
    await step('finalize', async () => {
      const closing = await db.raid.findMany({
        where: {
          trackingVersion: 2,
          status: 'ENDED',
          trackingPhase: { notIn: ['APPROVED', ...LOCKED_PHASES] },
        },
        select: { id: true, studioVersion: true, fundingAsset: true },
      });
      for (const raid of closing)
        await step(`settle:${raid.id}`, async () => {
          await finalizeTracking(raid.id);
          if (raid.fundingAsset === 'LAUNCH') await allocateLaunchCampaign(raid.id);
          else if (raid.studioVersion === 1) await allocateUsdcRaid(raid.id);
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
          OR: [
            { studioVersion: 1 },
            { fundingAsset: 'LAUNCH' },
            { mint: null, fundingLamports: { not: null } },
          ],
        },
        select: { id: true, studioVersion: true, fundingAsset: true },
      });
      for (const raid of approved)
        await step(`allocate:${raid.id}`, () =>
          raid.fundingAsset === 'LAUNCH'
            ? allocateLaunchCampaign(raid.id)
            : raid.studioVersion === 1
              ? allocateUsdcRaid(raid.id)
              : allocateRaidFunding(raid.id),
        );
    });
  }
  await step('launch-jobs', async () => {
    // Reconciling an already-broadcast launch or signed transaction is bookkeeping, so it runs while launchpads are deferred.
    const minute = Math.floor(Date.now() / 60000);
    const pendingLaunches = await db.tokenLaunch.findMany({
      where: {
        provider: 'PUMP',
        OR: [
          { status: 'SUBMITTED' },
          {
            status: 'PREPARED',
            signature: null,
            preparedHash: { not: null },
            updatedAt: { gt: new Date(+now - 86400000) },
          },
        ],
      },
      select: { id: true, status: true },
    });
    for (const launch of pendingLaunches)
      await enqueue(
        'launch-reconcile',
        launch.status === 'SUBMITTED'
          ? `launch-reconcile:${launch.id}:${minute}`
          : `launch-reconcile:${launch.id}:p${Math.floor(Date.now() / 300000)}`,
        { launchId: launch.id },
      );
    const signed = new Set(
      (
        await db.financialTx.findMany({
          where: { status: 'SIGNED' },
          distinct: ['launchId'],
          select: { launchId: true },
        })
      ).map((tx) => tx.launchId),
    );
    const ready = launchpadsAvailable
      ? new Set(
          (
            await db.rewardRound.findMany({
              where: { status: 'READY' },
              distinct: ['launchId'],
              select: { launchId: true },
            })
          ).map((round) => round.launchId),
        )
      : new Set<string>();
    const liveLaunches = await db.tokenLaunch.findMany({
      where: { provider: 'PUMP', status: { in: ['LIVE', 'PAUSED'] } },
      select: {
        id: true,
        status: true,
        raid: {
          select: {
            status: true,
            trackingVersion: true,
            trackingPhase: true,
            finalFeeSweepAt: true,
          },
        },
      },
    });
    for (const launch of liveLaunches) {
      const open = signed.has(launch.id);
      if (!launchpadsAvailable && !open) continue;
      if (launch.status === 'PAUSED' && !open) continue;
      const raid = launch.raid;
      const busy =
        open ||
        ready.has(launch.id) ||
        raid?.status === 'ACTIVE' ||
        (raid?.status === 'ENDED' &&
          !['ALLOCATED', 'HELD', 'HELD_RESOLVED'].includes(raid.trackingPhase)) ||
        (raid?.trackingVersion === 2 && !raid.finalFeeSweepAt);
      // claimJob serialises jobs sharing payload.raidId, so keep it set to the launch id.
      await enqueue(
        'finance',
        busy
          ? `finance:${launch.id}:${minute}`
          : `finance:${launch.id}:h${Math.floor(Date.now() / 3600000)}`,
        { launchId: launch.id, raidId: launch.id },
      );
    }
  });
  await step('meteora-jobs', async () => {
    // Meteora launches are independent of the deferred Pump launchpad and have their own switches.
    const minute = Math.floor(Date.now() / 60000);
    const launches = await db.tokenLaunch.findMany({
      where: {
        provider: 'METEORA',
        network: meteoraNetwork(),
        status: { in: ['PREPARED', 'SUBMITTED', 'LIVE', 'PAUSED'] },
      },
      select: { id: true, userId: true, status: true },
    });
    for (const launch of launches) {
      await step(`meteora:${launch.id}`, async () => {
        if (['PREPARED', 'SUBMITTED'].includes(launch.status)) {
          const submitted = await db.launchStep.count({
            where: {
              launchId: launch.id,
              kind: 'SETUP',
              status: { in: ['SUBMITTED', 'CONFIRMED'] },
            },
          });
          if (submitted)
            await enqueue('meteora-reconcile', `meteora-reconcile:${launch.id}:${minute}`, {
              launchId: launch.id,
              raidId: `meteora:${launch.id}`,
              userId: launch.userId,
            });
        } else
          await enqueue('meteora-finance', `meteora-finance:${launch.id}:${minute}`, {
            launchId: launch.id,
            raidId: `meteora:${launch.id}`,
          });
      });
    }
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
  await step('usdc-reconcile', async () => {
    const hour = Math.floor(+now / 3600000);
    const settings = usdcSettings();
    if (hour === reconciledHour || !settings.ready || settings.network === 'sandbox') return;
    reconciledHour = hour;
    const r = await reconcileUsdc(settings.network);
    if (r.surplus !== null && r.surplus < 0n)
      console.error(JSON.stringify({ alert: 'usdc-deficit', ...reconciliationJson(r) }));
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
    userId?: string;
  };
  try {
    if (job.kind === 'meteora-reconcile') await nextLaunchStep(p.launchId, p.userId!);
    else if (job.kind === 'meteora-finance') await financeMeteoraLaunch(p.launchId);
    else if (job.kind === 'launch-reconcile') await reconcileLaunch(p.launchId);
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
          ...(market?.name.trim() && market.symbol.trim()
            ? {
                name: market.name.trim().slice(0, 80),
                symbol: market.symbol.trim().slice(0, 15),
                ...(market.imageUri ? { imageUri: market.imageUri } : {}),
                metadataSource: 'MARKET',
                metadataVerifiedAt: new Date(),
              }
            : {}),
        },
      });
    }
    await finishJob(job);
    if (p.raidId && ['submission', 'tracking-correction'].includes(job.kind))
      await clearCollectionError(p.raidId);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Collection failed';
    if (p.raidId && !['finance', 'meteora-finance', 'meteora-reconcile'].includes(job.kind))
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
