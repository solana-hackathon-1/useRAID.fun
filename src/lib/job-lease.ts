import { AsyncLocalStorage } from 'node:async_hooks';
import type { Job } from '@prisma/client';
import { db } from './db';
/** How long a claimed job stays owned by its worker. claimJob() reclaims a job whose lock is older than this. */
export const JOB_LEASE_MINUTES = 10;
export class JobLeaseLostError extends Error {
  constructor() {
    super('Job lease was lost; the external effect was not performed.');
    this.name = 'JobLeaseLostError';
  }
}
type Held = Pick<Job, 'id' | 'lease'>;
const held = new AsyncLocalStorage<Held>();
/** Run a job handler so any code beneath it can call assertJobLease() without the job being threaded through. */
export function runUnderJobLease<T>(job: Held, fn: () => Promise<T>) {
  return held.run({ id: job.id, lease: job.lease }, fn);
}
/**
 * Call immediately before an external side effect (provider call, broadcast, send). Throws JobLeaseLostError when
 * this worker's claim generation no longer owns the job: another worker reclaimed it (new lease), it was finished or
 * dead-lettered, or its lease already ran out and may be reclaimed at any moment. Outside a job it does nothing, so
 * code shared with request handlers is unaffected.
 *
 * Expiry is judged by the database clock, the one claimJob() uses; never compare against the app clock here.
 * The check and the effect are not atomic, so this narrows the stale-worker window to the instant between them;
 * effects that must be exactly-once still need a provider-side idempotency key.
 */
export async function assertJobLease() {
  const job = held.getStore();
  if (!job) return;
  const owned = job.lease
    ? await db.$queryRaw<
        { id: string }[]
      >`SELECT id FROM "Job" WHERE id=${job.id} AND "lease"=${job.lease} AND "doneAt" IS NULL AND "failedAt" IS NULL AND "lockedAt">(NOW() AT TIME ZONE 'UTC')-make_interval(mins => ${JOB_LEASE_MINUTES}::int)`
    : [];
  if (!owned.length) throw new JobLeaseLostError();
}
