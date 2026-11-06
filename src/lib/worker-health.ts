import { db } from './db';
import { JOB_LEASE_MINUTES } from './job-lease';
import { JOB_MAX_ATTEMPTS } from './queue';

/**
 * Durable worker health (T038, blueprint §27.3/§30.3). Diagnostic only: nothing here gates, retries or revives work.
 * Host contract: needs a Prisma `db` with the `WorkerStepHealth`, `Job`, `OutboxEvent`, `AuditEvent` and
 * `NotificationDispatch` tables; the clock is injectable. Output carries counts, ages and step names only - never job
 * payloads, keys or error messages.
 */
/** The worker schedule runs about once a minute; a step with no success for this long is stale. */
export const STEP_STALE_MS = 5 * 60 * 1000;
export const FAILING_STREAK = 3;
export const JOB_OVERDUE_SECONDS = 15 * 60;
export const OUTBOX_OVERDUE_SECONDS = 15 * 60;
/** The claim query treats a lock older than this as abandoned; derived from the one lease constant. */
export const LEASE_SECONDS = JOB_LEASE_MINUTES * 60;

/** Error class name only: a message can carry provider bodies or secrets. */
function errorKind(error: unknown) {
  const name = error instanceof Error ? error.constructor.name || error.name : 'Unknown';
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : 'Error';
}
/** Best-effort and atomic across overlapping workers. Never throws: health must not break the step it observes. */
export async function recordStepOutcome(
  stepName: string,
  failure?: { error: unknown },
  at = new Date(),
) {
  try {
    const kind = failure ? errorKind(failure.error) : null;
    if (failure)
      await db.$executeRaw`INSERT INTO "WorkerStepHealth" ("step","lastRunAt","lastFailureAt","consecutiveFailures","lastErrorKind")
        VALUES (${stepName.slice(0, 120)}, ${at}, ${at}, 1, ${kind})
        ON CONFLICT ("step") DO UPDATE SET "lastRunAt"=EXCLUDED."lastRunAt", "lastFailureAt"=EXCLUDED."lastFailureAt",
          "consecutiveFailures"="WorkerStepHealth"."consecutiveFailures"+1, "lastErrorKind"=EXCLUDED."lastErrorKind"`;
    else
      await db.$executeRaw`INSERT INTO "WorkerStepHealth" ("step","lastRunAt","lastSuccessAt")
        VALUES (${stepName.slice(0, 120)}, ${at}, ${at})
        ON CONFLICT ("step") DO UPDATE SET "lastRunAt"=EXCLUDED."lastRunAt", "lastSuccessAt"=EXCLUDED."lastSuccessAt",
          "consecutiveFailures"=0, "lastErrorKind"=NULL`;
  } catch (error) {
    console.error(
      JSON.stringify({
        step: 'worker-health',
        error: error instanceof Error ? error.message : 'unavailable',
      }),
    );
  }
}

export type WorkerHealthStatus = 'ok' | 'degraded' | 'unknown';
export async function workerHealthSnapshot(
  now = new Date(),
  options: { outboxDispatchEnabled?: boolean } = {},
) {
  // Collapse per-iteration collect/measure/settle steps (`collect:<raidId>`) so identifiers never reach the signal.
  const rows = await db.workerStepHealth.findMany({
    where: { step: { not: { contains: ':' } } },
    orderBy: { step: 'asc' },
  });
  const steps = rows.map((row) => ({
    step: row.step,
    lastRunAt: row.lastRunAt,
    lastSuccessAt: row.lastSuccessAt,
    lastFailureAt: row.lastFailureAt,
    consecutiveFailures: row.consecutiveFailures,
    lastErrorKind: row.lastErrorKind,
    stale: +now - +(row.lastSuccessAt ?? row.lastRunAt) > STEP_STALE_MS,
    failing: row.consecutiveFailures >= FAILING_STREAK,
  }));
  const [jobs] = await db.$queryRaw<
    {
      oldest: number | null;
      stale: bigint;
      dead: bigint;
      exhausted: bigint;
    }[]
  >`SELECT
      EXTRACT(EPOCH FROM ((NOW() AT TIME ZONE 'UTC') - MIN("runAt") FILTER (WHERE "doneAt" IS NULL AND "failedAt" IS NULL AND "attempts" < ${JOB_MAX_ATTEMPTS} AND "runAt" <= (NOW() AT TIME ZONE 'UTC') AND ("lockedAt" IS NULL OR "lockedAt" < (NOW() AT TIME ZONE 'UTC') - make_interval(secs => ${LEASE_SECONDS})))))::float8 AS oldest,
      COUNT(*) FILTER (WHERE "doneAt" IS NULL AND "failedAt" IS NULL AND "lockedAt" < (NOW() AT TIME ZONE 'UTC') - make_interval(secs => ${LEASE_SECONDS})) AS stale,
      COUNT(*) FILTER (WHERE "failedAt" IS NOT NULL) AS dead,
      COUNT(*) FILTER (WHERE "doneAt" IS NULL AND "failedAt" IS NULL AND "attempts" >= ${JOB_MAX_ATTEMPTS}) AS exhausted
    FROM "Job"`;
  const outbox = options.outboxDispatchEnabled
    ? (
        await db.$queryRaw<{ pending: bigint; oldest: number | null }[]>`
          SELECT COUNT(*) AS pending, EXTRACT(EPOCH FROM (clock_timestamp() - MIN(o."createdAt")))::float8 AS oldest
          FROM "OutboxEvent" o JOIN "AuditEvent" a ON a."id"=o."eventId"
          WHERE a."eventType" LIKE 'work.%' AND NOT EXISTS (SELECT 1 FROM "NotificationDispatch" d WHERE d."outboxEventId"=o."id")`
      )[0]
    : null;
  const oldestRunnableAgeSeconds =
    jobs.oldest === null ? null : Math.max(0, Math.floor(jobs.oldest));
  const outboxSummary = {
    dispatchEnabled: !!options.outboxDispatchEnabled,
    pending: outbox ? Number(outbox.pending) : null,
    oldestPendingAgeSeconds:
      outbox && outbox.oldest !== null ? Math.max(0, Math.floor(outbox.oldest)) : null,
  };
  const reasons = [
    ...steps.filter((s) => s.stale).map((s) => `step-stale:${s.step}`),
    ...steps.filter((s) => s.failing).map((s) => `step-failing:${s.step}`),
    ...(Number(jobs.stale) ? ['jobs-stale-lease'] : []),
    ...(Number(jobs.dead) ? ['jobs-dead-letter'] : []),
    ...(Number(jobs.exhausted) ? ['jobs-exhausted'] : []),
    ...(oldestRunnableAgeSeconds !== null && oldestRunnableAgeSeconds > JOB_OVERDUE_SECONDS
      ? ['jobs-overdue']
      : []),
    ...((outboxSummary.oldestPendingAgeSeconds ?? 0) > OUTBOX_OVERDUE_SECONDS
      ? ['outbox-overdue']
      : []),
  ];
  const heartbeatAt = rows.reduce<Date | null>(
    (a, r) => (!a || r.lastRunAt > a ? r.lastRunAt : a),
    null,
  );
  const status: WorkerHealthStatus = !rows.length ? 'unknown' : reasons.length ? 'degraded' : 'ok';
  return {
    generatedAt: now,
    status,
    heartbeatAt,
    reasons,
    steps,
    jobs: {
      oldestRunnableAgeSeconds,
      staleLeases: Number(jobs.stale),
      deadLettered: Number(jobs.dead),
      exhausted: Number(jobs.exhausted),
    },
    outbox: outboxSummary,
  };
}
