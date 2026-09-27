import { randomUUID } from 'node:crypto';
import { Prisma, type Job } from '@prisma/client';
import { db } from './db';
export async function enqueue(
  kind: string,
  key: string,
  payload: Prisma.InputJsonValue,
  runAt = new Date(),
) {
  return db.job.upsert({ where: { key }, create: { kind, key, payload, runAt }, update: {} });
}
export async function claimJob() {
  const lease = randomUUID();
  const rows = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(729104)`;
    return tx.$queryRaw<
      Job[]
    >`UPDATE "Job" SET "lockedAt"=NOW(), "lease"=${lease}, "attempts"="attempts"+1 WHERE id=(SELECT candidate.id FROM "Job" candidate WHERE candidate."doneAt" IS NULL AND candidate."attempts"<8 AND candidate."runAt"<=NOW() AND (candidate."lockedAt" IS NULL OR candidate."lockedAt"<NOW()-INTERVAL '10 minutes') AND NOT EXISTS (SELECT 1 FROM "Job" running WHERE running.id<>candidate.id AND running."doneAt" IS NULL AND running."lockedAt">NOW()-INTERVAL '10 minutes' AND running.payload->>'raidId'=candidate.payload->>'raidId') ORDER BY candidate."runAt" FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`;
  });
  return rows[0] || null;
}
export async function finishJob(job: Job, error?: string, delaySeconds?: number) {
  await db.job.updateMany({
    where: { id: job.id, lease: job.lease },
    data: error
      ? {
          lockedAt: null,
          lease: null,
          error,
          runAt: new Date(
            Date.now() + (delaySeconds || Math.min(900, 30 * 2 ** job.attempts)) * 1000,
          ),
        }
      : { doneAt: new Date(), lockedAt: null, lease: null, error: null },
  });
}
