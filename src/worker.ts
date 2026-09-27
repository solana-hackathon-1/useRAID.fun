import 'dotenv/config';
import { Prisma } from '@prisma/client';
import { db } from './lib/db';
import { config } from './lib/config';
import { claimJob, enqueue, finishJob } from './lib/queue';
import { collect, ingest, refresh, snapshot } from './lib/collection';
import { fetchMarket } from './lib/providers/market';
import { lookupPosts, ProviderError } from './lib/providers/x';
let stopping = false;
process.on('SIGTERM', () => {
  stopping = true;
});
process.on('SIGINT', () => {
  stopping = true;
});
async function schedule() {
  const now = new Date();
  await db.raid.updateMany({
    where: { status: 'SCHEDULED', startsAt: { lte: now } },
    data: { status: 'ACTIVE' },
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
    await enqueue('collect', `collect:${raid.id}:${Math.floor(Date.now() / 300000)}`, {
      raidId: raid.id,
    });
    if (raid.status === 'ACTIVE') {
      await enqueue('market', `market:${raid.mint}:${Math.floor(Date.now() / 60000)}`, {
        mint: raid.mint,
      });
      await snapshot(
        raid.id,
        raid.coverage === 'complete' && !!raid.observedAt && Date.now() - +raid.observedAt < 600000,
      );
    }
  }
  await db.session.deleteMany({ where: { expiresAt: { lt: now } } });
  await db.oAuthAttempt.deleteMany({ where: { expiresAt: { lt: now } } });
  await db.rateLimit.deleteMany({ where: { expiresAt: { lt: now } } });
  await db.post.updateMany({
    where: {
      createdAt: { lt: new Date(Date.now() - config.retentionDays * 86400000) },
      deleted: false,
    },
    data: { text: '', normalized: '', deleted: true },
  });
  await db.job.deleteMany({ where: { doneAt: { lt: new Date(Date.now() - 7 * 86400000) } } });
  // Daily reconciliation for ended campaigns within the configured retention period.
  const ended = await db.raid.findMany({
    where: {
      status: 'ENDED',
      hidden: false,
      finalRefreshed: true,
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
        raidId: string;
        mint: string;
        after: string;
        final: boolean;
        postId: string;
      };
      try {
        if (job.kind === 'collect') await collect(p.raidId);
        else if (job.kind === 'refresh') await refresh(p.raidId, p.after, p.final);
        else if (job.kind === 'submission') {
          const raid = await db.raid.findUniqueOrThrow({
            where: { id: p.raidId },
            include: { creator: true },
          });
          if (raid.hidden || raid.creator.suspended || raid.status !== 'ACTIVE')
            throw new Error('Raid is not accepting submissions.');
          const result = await lookupPosts([p.postId], p.raidId);
          await ingest(p.raidId, result.data || []);
          await snapshot(p.raidId, false);
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
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Collection failed';
        if (p.raidId)
          await db.raid.updateMany({
            where: { id: p.raidId },
            data: { coverage: 'partial', collectionError: message },
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
