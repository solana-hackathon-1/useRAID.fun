import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma, type Job } from '@prisma/client';
import { db } from './db';
/** How long a claimed job stays owned by its worker. claimJob() reclaims a job whose lock is older than this. */
export const JOB_LEASE_MINUTES = 10;
export class JobLeaseLostError extends Error {
  constructor() {
    super('Job lease was lost; the external effect was not performed.');
    this.name = 'JobLeaseLostError';
  }
}
/** Renew at a third of the lease, so two consecutive failed renewals still leave a third of it. Derived, not tuned. */
export const JOB_LEASE_RENEW_MS = (JOB_LEASE_MINUTES * 60000) / 3;
type Held = Pick<Job, 'id' | 'lease'>;
/** `lost` is set by the renewal timer the moment the database says this worker no longer owns the job. */
const held = new AsyncLocalStorage<Held & { lost: boolean }>();
/**
 * Extend this worker's claim by restarting the lease clock, but only while it still owns the job: the same ownership
 * test as assertJobLease() (same lease generation, unfinished, not yet expired by the database clock) in one atomic
 * UPDATE. It returns false and writes nothing once the lease expired, was reclaimed, finished or dead-lettered, so a
 * stalled worker can never revive a lease that claimJob() or the dead-letter sweep may already have taken. Row locking
 * decides a race between a renewal and the sweep: exactly one of them wins the row.
 */
export async function renewJobLease(job: Held) {
  if (!job.lease) return false;
  const renewed =
    await db.$executeRaw`UPDATE "Job" SET "lockedAt"=(NOW() AT TIME ZONE 'UTC') WHERE id=${job.id} AND "lease"=${job.lease} AND "doneAt" IS NULL AND "failedAt" IS NULL AND "lockedAt">(NOW() AT TIME ZONE 'UTC')-make_interval(mins => ${JOB_LEASE_MINUTES}::int)`;
  return renewed === 1;
}
/**
 * Run a job handler so any code beneath it can call assertJobLease() without the job being threaded through. While
 * the handler runs the lease is renewed every `renewEveryMs`, so a job longer than the lease keeps its claim instead
 * of being reclaimed mid-run; renewal stops when the handler settles. A failed renewal (database blip) is retried on
 * the next tick and never aborts the job: the next assertJobLease() still decides from the database. A renewal that
 * finds the lease gone marks the run lost, so the very next assertJobLease() refuses before any further effect.
 * Nothing caps total run time here: a handler that never settles keeps renewing, so provider calls must carry their own timeouts.
 */
export function runUnderJobLease<T>(
  job: Held,
  fn: () => Promise<T>,
  options: { renewEveryMs?: number } = {},
) {
  const store = { id: job.id, lease: job.lease, lost: false };
  let renewing = false;
  const timer = job.lease
    ? setInterval(() => {
        if (renewing || store.lost) return;
        renewing = true;
        renewJobLease(store)
          .then((ok) => {
            if (ok) return;
            store.lost = true;
            console.error(
              JSON.stringify({ job: job.id, error: 'Job lease was lost while running.' }),
            );
          })
          .catch(() => {
            console.error(JSON.stringify({ job: job.id, error: 'Job lease renewal failed.' }));
          })
          .finally(() => {
            renewing = false;
          });
      }, options.renewEveryMs ?? JOB_LEASE_RENEW_MS)
    : null;
  timer?.unref();
  return held.run(store, fn).finally(() => {
    if (timer) clearInterval(timer);
  });
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
const ownedBy = (job: Held) =>
  Prisma.sql`SELECT id FROM "Job" WHERE id=${job.id} AND "lease"=${job.lease} AND "doneAt" IS NULL AND "failedAt" IS NULL AND "lockedAt">(NOW() AT TIME ZONE 'UTC')-make_interval(mins => ${JOB_LEASE_MINUTES}::int)`;
export async function assertJobLease() {
  const job = held.getStore();
  if (!job) return;
  if (job.lost) throw new JobLeaseLostError();
  const owned = job.lease ? await db.$queryRaw<{ id: string }[]>`${ownedBy(job)}` : [];
  if (!owned.length) throw new JobLeaseLostError();
}

/**
 * Run database writes only while this worker still owns the job, and return false (writing nothing) when it does not.
 * The ownership row is locked FOR UPDATE for the transaction, so claimJob() cannot hand the job to another worker
 * between the check and the writes; a worker whose lease was lost, reclaimed, finished or dead-lettered writes nothing.
 * Use it for a failing worker's bookkeeping (error text on the raid/token) so a stale worker cannot overwrite the
 * state owned by the current holder.
 */
export async function whileJobLeaseHeld(
  job: Held,
  writes: (tx: Prisma.TransactionClient) => Promise<unknown>,
) {
  if (!job.lease) return false;
  return db.$transaction(async (tx) => {
    const owned = await tx.$queryRaw<{ id: string }[]>`${ownedBy(job)} FOR UPDATE`;
    if (!owned.length) return false;
    await writes(tx);
    return true;
  });
}
