import { randomUUID } from 'node:crypto';
import { Prisma, type Job } from '@prisma/client';
import { db } from './db';
export async function enqueue(
  kind: string,
  key: string,
  payload: Prisma.InputJsonValue,
  runAt = new Date(),
) {
  return db.job.upsert({
    where: { key },
    create: {
      kind,
      key,
      payload,
      runAt,
      priority: (payload as { final?: boolean }).final
        ? 30
        : kind === 'submission'
          ? 20
          : kind === 'finance' || kind === 'launch-reconcile'
            ? 15
            : kind === 'collect' || kind === 'refresh'
              ? 10
              : 0,
    },
    update: {},
  });
}
export const JOB_MAX_ATTEMPTS = 8;
export async function claimJob() {
  const lease = randomUUID();
  const rows = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(729104)`;
    return tx.$queryRaw<
      Job[]
    >`UPDATE "Job" SET "lockedAt"=(NOW() AT TIME ZONE 'UTC'), "lease"=${lease}, "attempts"="attempts"+1 WHERE id=(SELECT candidate.id FROM "Job" candidate WHERE candidate."doneAt" IS NULL AND candidate."failedAt" IS NULL AND candidate."attempts"<${JOB_MAX_ATTEMPTS} AND candidate."runAt"<=(NOW() AT TIME ZONE 'UTC') AND (candidate."lockedAt" IS NULL OR candidate."lockedAt"<(NOW() AT TIME ZONE 'UTC')-INTERVAL '10 minutes') AND NOT EXISTS (SELECT 1 FROM "Job" running WHERE running.id<>candidate.id AND running."doneAt" IS NULL AND running."failedAt" IS NULL AND running."lockedAt">(NOW() AT TIME ZONE 'UTC')-INTERVAL '10 minutes' AND running.payload->>'raidId'=candidate.payload->>'raidId') ORDER BY candidate."priority" DESC, candidate."runAt" FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`;
  });
  return rows[0] || null;
}
export async function finishJob(
  job: Job,
  error?: string,
  delaySeconds?: number,
  options: { refundAttempt?: boolean } = {},
) {
  if (!error) {
    await db.job.updateMany({
      where: { id: job.id, lease: job.lease },
      data: { doneAt: new Date(), lockedAt: null, lease: null, error: null },
    });
    return { dead: false };
  }
  const dead = !options.refundAttempt && job.attempts >= JOB_MAX_ATTEMPTS;
  const updated = await db.job.updateMany({
    where: { id: job.id, lease: job.lease },
    data: {
      lockedAt: null,
      lease: null,
      error,
      ...(options.refundAttempt ? { attempts: { decrement: 1 } } : {}),
      ...(dead ? { failedAt: new Date() } : {}),
      runAt: new Date(Date.now() + (delaySeconds || Math.min(900, 30 * 2 ** job.attempts)) * 1000),
    },
  });
  return { dead: dead && updated.count === 1 };
}
