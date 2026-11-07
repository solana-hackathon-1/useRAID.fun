import { lockResource } from '../identity-locks';
import { lockAdvisory } from './identity-protocol';
import { randomUUID } from 'node:crypto';
import { Prisma, type Job } from '@prisma/client';
import { db } from './db';
import { JOB_LEASE_MINUTES } from './job-lease';
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
          : kind === 'collect' || kind === 'refresh'
            ? 10
            : kind === 'finance' || kind === 'launch-reconcile'
              ? 5
              : 0,
    },
    update: {},
  });
}
export const JOB_MAX_ATTEMPTS = 8;
export async function claimJob() {
  const lease = randomUUID();
  const rows = await db.$transaction(async (tx) => {
    await lockAdvisory(tx, lockResource('global', '729104'));
    return tx.$queryRaw<
      Job[]
    >`UPDATE "Job" SET "lockedAt"=(NOW() AT TIME ZONE 'UTC'), "lease"=${lease}, "attempts"="attempts"+1 WHERE id=(SELECT candidate.id FROM "Job" candidate WHERE candidate."doneAt" IS NULL AND candidate."failedAt" IS NULL AND candidate."attempts"<${JOB_MAX_ATTEMPTS} AND candidate."runAt"<=(NOW() AT TIME ZONE 'UTC') AND (candidate."lockedAt" IS NULL OR candidate."lockedAt"<(NOW() AT TIME ZONE 'UTC')-make_interval(mins => ${JOB_LEASE_MINUTES}::int)) AND NOT EXISTS (SELECT 1 FROM "Job" running WHERE running.id<>candidate.id AND running."doneAt" IS NULL AND running."failedAt" IS NULL AND running."lockedAt">(NOW() AT TIME ZONE 'UTC')-make_interval(mins => ${JOB_LEASE_MINUTES}::int) AND running.payload->>'raidId'=candidate.payload->>'raidId') ORDER BY candidate."priority" DESC, candidate."runAt" FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`;
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
export const EXHAUSTED_JOB_ERROR =
  'The job used all its attempts without finishing (worker crash or lost lease).';
/**
 * Dead-letter jobs that used every attempt but were never finished or failed: each attempt was claimed and then the
 * worker crashed or lost its lease, so finishJob() never ran for the last one. claimJob() never picks such a job
 * again, so without this it would sit unfinished forever. Only a job whose lease has expired by the database clock
 * qualifies, so an eighth attempt still running (and renewing) is never touched. One UPDATE decides each job: a
 * concurrent sweep, renewal or late finishJob() either sees the job already failed with its lease cleared and writes
 * nothing, or wins the row first.
 *
 * Each job has its own transaction, and `resolve` runs inside it, so whatever depended on the job (a QUEUED
 * PostSubmission, a Raid's collection state) is resolved atomically with the dead-lettering, never left behind by a
 * crash between the two. A job whose `resolve` throws rolls back alone, stays exhausted for the next sweep and is
 * returned in `failed`, so one poison job can neither block the others nor go unreported.
 */
export async function deadLetterExhaustedJobs(
  resolve?: (tx: Prisma.TransactionClient, job: Job) => Promise<void>,
) {
  const candidates = await db.$queryRaw<
    { id: string }[]
  >`SELECT id FROM "Job" WHERE "doneAt" IS NULL AND "failedAt" IS NULL AND "attempts">=${JOB_MAX_ATTEMPTS} AND ("lockedAt" IS NULL OR "lockedAt"<(NOW() AT TIME ZONE 'UTC')-make_interval(mins => ${JOB_LEASE_MINUTES}::int)) ORDER BY "runAt"`;
  const dead: Job[] = [];
  const failed: { id: string; error: unknown }[] = [];
  for (const { id } of candidates) {
    try {
      const job = await db.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<
          Job[]
        >`UPDATE "Job" SET "failedAt"=(NOW() AT TIME ZONE 'UTC'), "lockedAt"=NULL, "lease"=NULL, "error"=COALESCE("error", ${EXHAUSTED_JOB_ERROR}) WHERE id=${id} AND "doneAt" IS NULL AND "failedAt" IS NULL AND "attempts">=${JOB_MAX_ATTEMPTS} AND ("lockedAt" IS NULL OR "lockedAt"<(NOW() AT TIME ZONE 'UTC')-make_interval(mins => ${JOB_LEASE_MINUTES}::int)) RETURNING *`;
        if (row) await resolve?.(tx, row);
        return row;
      });
      if (job) dead.push(job);
    } catch (error) {
      failed.push({ id, error });
    }
  }
  return { dead, failed };
}
