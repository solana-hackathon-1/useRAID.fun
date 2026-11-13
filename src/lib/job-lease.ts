import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma, type Job } from '@prisma/client';
import { db } from './db';
import { correlationFields } from './worker-diagnostics';
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
/**
 * Total-run cap on renewal (DEC-2026-11-13-07 a, provisional): one attempt renews its lease for at most this long,
 * measured from the claim by the database clock. At the cap the run is marked lost, so assertJobLease() refuses at
 * once; the lease row then runs out and the attempt counts as lost (retried or dead-lettered as usual), so a hung
 * handler cannot hold a job forever.
 */
export const JOB_LEASE_MAX_RUN_MS = 60 * 60000;
/** `lockedAt` is the claim time returned by claimJob(); the cap is measured from it. */
type Held = Pick<Job, 'id' | 'lease'> & { lockedAt?: Date | null };
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
 *
 * Total-run cap: on each tick the database clock is asked whether `maxRunMs` (JOB_LEASE_MAX_RUN_MS, 60 minutes) have
 * passed since the claim (`job.lockedAt`, read from the row when the caller has no claim time). If so the run is
 * marked lost, renewal stops for good and one JOB_LEASE_CAP line is logged; assertJobLease() refuses immediately.
 * Tolerance: the cap is noticed only on a tick, so in-process refusal begins between `maxRunMs` and `maxRunMs` plus
 * one tick (60 to about 63.3 minutes); the last renewal still leaves the row leased for up to a further lease, so
 * another worker cannot reclaim before about 70 minutes after the claim. An effect already in flight when the cap is
 * noticed is not interrupted; provider calls should still carry their own timeouts. No app clock is consulted.
 */
export async function runUnderJobLease<T>(
  job: Held,
  fn: () => Promise<T>,
  options: { renewEveryMs?: number; maxRunMs?: number } = {},
) {
  const store = { id: job.id, lease: job.lease, lost: false };
  const maxRunMs = options.maxRunMs ?? JOB_LEASE_MAX_RUN_MS;
  let claimedAt: Date | null = null;
  if (job.lease)
    claimedAt =
      job.lockedAt ??
      (
        await db.$queryRaw<
          { at: Date }[]
        >`SELECT COALESCE((SELECT "lockedAt" FROM "Job" WHERE id=${job.id} AND "lease"=${job.lease}), NOW() AT TIME ZONE 'UTC') AS at`
      )[0].at;
  let renewing = false;
  const stopAtCap = () => {
    store.lost = true;
    clearInterval(timer!);
    console.error(
      JSON.stringify({
        job: job.id,
        code: 'JOB_LEASE_CAP',
        note: 'lease renewal stopped at the total-run cap',
        ...correlationFields(),
      }),
    );
  };
  const timer: ReturnType<typeof setInterval> | null = job.lease
    ? setInterval(() => {
        if (renewing || store.lost) return;
        renewing = true;
        capReached(claimedAt!, maxRunMs)
          .then(async (capped) => {
            if (capped) return stopAtCap();
            if (await renewJobLease(store)) return;
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
  try {
    return await held.run(store, fn);
  } finally {
    if (timer) clearInterval(timer);
  }
}
/** Has `maxRunMs` passed since `claimedAt`, by the database clock (the one that decides lease expiry)? */
async function capReached(claimedAt: Date, maxRunMs: number) {
  const [row] = await db.$queryRaw<
    { capped: boolean }[]
  >`SELECT ((NOW() AT TIME ZONE 'UTC') >= (${claimedAt}::timestamptz AT TIME ZONE 'UTC') + make_interval(secs => ${maxRunMs / 1000}::float8)) AS capped`;
  return row.capped;
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
