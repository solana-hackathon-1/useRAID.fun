import { db } from './db';
import type { Prisma } from '@prisma/client';
import { JOB_LEASE_MINUTES } from './job-lease';
import { JOB_MAX_ATTEMPTS } from './queue';
import { correlationFields } from './worker-diagnostics';

/**
 * Durable worker health (T038, blueprint §27.3/§30.3). Diagnostic only: nothing here gates, retries or revives work.
 * Host contract: needs a Prisma `db` with the `WorkerStepHealth`, `Job`, `OutboxEvent`, `AuditEvent` and
 * `NotificationDispatch` tables, plus (read-only) `Engagement`, `FinancialTx`, `TokenLaunch`, `Raid`, `Token` and
 * `Settings` for the commitment, transaction and provider signals; the clock is injectable. Output carries counts, ages
 * and step names only - never job payloads, keys, identifiers, signatures or error messages.
 */
/** The worker schedule runs about once a minute; a step with no success for this long is stale. */
export const STEP_STALE_MS = 5 * 60 * 1000;
/**
 * A step row this old, while some other step is still running, belongs to a step that was removed or renamed and no
 * longer counts. With no recent heartbeat anywhere nothing is retired: a dead worker must stay visible.
 */
export const STEP_RETIRE_MS = 24 * 60 * 60 * 1000;
/** Recording is best-effort: wait this long for the database, then skip recording for the cooldown. */
export const RECORD_TIMEOUT_MS = 2000;
export const RECORD_COOLDOWN_MS = 30 * 1000;
export const FAILING_STREAK = 3;
export const JOB_OVERDUE_SECONDS = 15 * 60;
export const OUTBOX_OVERDUE_SECONDS = 15 * 60;
/** A signed transaction or submitted launch with no known outcome after this long needs an operator (reconcile gives up its own retries well before). */
export const TX_UNKNOWN_SECONDS = 30 * 60;
/** An active campaign whose provider data is older than this is stale (collection runs every 5 minutes, market every minute). */
export const PROVIDER_STALE_SECONDS = 30 * 60;
/** The closure worker runs every minute; an active engagement past its accepted operational deadline longer than this is overdue. */
export const COMMITMENT_OVERDUE_SECONDS = 15 * 60;
/** Every named step `schedule()` runs; a drift test keeps this identical to worker-jobs.ts. */
export const KNOWN_WORKER_STEPS: readonly string[] = [
  'notifications',
  'work-closure',
  'finance-readiness',
  'status-transitions',
  'coverage-expired',
  'collect',
  'measure',
  'finalize',
  'allocate-retry',
  'launch-jobs',
  'cleanup',
  'retention',
  'reconcile',
  'usdc-reconcile',
];
/** Steps that only run while tracking is enabled: the money path (measure, settle, allocate). */
const TRACKING_STEPS: readonly string[] = ['measure', 'finalize', 'allocate-retry'];
/** The claim query treats a lock older than this as abandoned; derived from the one lease constant. */
export const LEASE_SECONDS = JOB_LEASE_MINUTES * 60;

/** Error class name only: a message can carry provider bodies or secrets. */
function errorKind(error: unknown) {
  const name = error instanceof Error ? error.constructor.name || error.name : 'Unknown';
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : 'Error';
}
let skipRecordingUntil = 0;
/** Test hook: forget a tripped recording cooldown. */
export function resetRecordingBreaker() {
  skipRecordingUntil = 0;
}
/**
 * Best-effort and atomic across overlapping workers. Never throws: health must not break the step it observes.
 * A hung database would otherwise add a pool timeout to every step, so a wait beyond RECORD_TIMEOUT_MS gives up and
 * skips recording for RECORD_COOLDOWN_MS (the schedule keeps its pace; the missing heartbeat shows as stale).
 */
export async function recordStepOutcome(
  stepName: string,
  failure?: { error: unknown },
  at = new Date(),
) {
  if (Date.now() < skipRecordingUntil) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const kind = failure ? errorKind(failure.error) : null;
    const write = Promise.resolve(
      failure
        ? db.$executeRaw`INSERT INTO "WorkerStepHealth" ("step","lastRunAt","lastFailureAt","consecutiveFailures","lastErrorKind")
        VALUES (${stepName.slice(0, 120)}, ${at}, ${at}, 1, ${kind})
        ON CONFLICT ("step") DO UPDATE SET "lastRunAt"=EXCLUDED."lastRunAt", "lastFailureAt"=EXCLUDED."lastFailureAt",
          "consecutiveFailures"="WorkerStepHealth"."consecutiveFailures"+1, "lastErrorKind"=EXCLUDED."lastErrorKind"`
        : db.$executeRaw`INSERT INTO "WorkerStepHealth" ("step","lastRunAt","lastSuccessAt")
        VALUES (${stepName.slice(0, 120)}, ${at}, ${at})
        ON CONFLICT ("step") DO UPDATE SET "lastRunAt"=EXCLUDED."lastRunAt", "lastSuccessAt"=EXCLUDED."lastSuccessAt",
          "consecutiveFailures"=0, "lastErrorKind"=NULL`,
    );
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        skipRecordingUntil = Date.now() + RECORD_COOLDOWN_MS;
        reject(new Error('timed out'));
      }, RECORD_TIMEOUT_MS);
    });
    // A late rejection of the abandoned write must not become an unhandled rejection.
    write.then(undefined, () => {});
    await Promise.race([write, timedOut]);
  } catch (error) {
    console.error(
      JSON.stringify({
        step: 'worker-health',
        error: error instanceof Error ? error.message : 'unavailable',
        ...correlationFields(),
      }),
    );
  } finally {
    clearTimeout(timer);
  }
}

export type WorkerHealthStatus = 'ok' | 'degraded' | 'unknown';
export interface WorkerHealthOptions {
  outboxDispatchEnabled?: boolean;
  /** Explicit `false` lets the tracking steps retire; anything else keeps them visible when they stop (money path). */
  trackingEnabled?: boolean;
  /** Commitment overdue is only a reason while the closure worker is switched on. */
  closureEnabled?: boolean;
  commitmentOverdueSeconds?: number;
  statementTimeoutMs?: number;
}
const seconds = (value: number | null) => (value === null ? null : Math.max(0, Math.floor(value)));
/** Each health query's ceiling: these are full scans on an operator path, so a slow one fails rather than lingers. */
export const HEALTH_STATEMENT_TIMEOUT_MS = 5000;
const HEALTH_QUERY_COUNT = 8;
export async function workerHealthSnapshot(now = new Date(), options: WorkerHealthOptions = {}) {
  const limit = options.statementTimeoutMs ?? HEALTH_STATEMENT_TIMEOUT_MS;
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(limit)}, true)`;
      return readSnapshot(tx, now, options);
    },
    { maxWait: limit, timeout: limit * (HEALTH_QUERY_COUNT + 1) },
  );
}
async function readSnapshot(
  client: Prisma.TransactionClient,
  now: Date,
  options: WorkerHealthOptions,
) {
  // Collapse per-iteration collect/measure/settle steps (`collect:<raidId>`) so identifiers never reach the signal.
  const all = await client.workerStepHealth.findMany({
    where: { step: { not: { contains: ':' } } },
    orderBy: { step: 'asc' },
  });
  const heartbeat = all.reduce<Date | null>(
    (a, r) => (!a || r.lastRunAt > a ? r.lastRunAt : a),
    null,
  );
  // Retire rows of removed/renamed steps, but only while another step is alive (see STEP_RETIRE_MS). A step the
  // schedule still defines is never retired merely for silence, except the tracking steps when tracking is off:
  // otherwise a money-path step that stopped running would vanish from the signal after a day.
  const alive = heartbeat !== null && +now - +heartbeat <= STEP_STALE_MS;
  const retiredReason = (r: { step: string; lastRunAt: Date }) => {
    if (!alive || +now - +r.lastRunAt <= STEP_RETIRE_MS) return null;
    if (!KNOWN_WORKER_STEPS.includes(r.step)) return 'unknown-step' as const;
    return TRACKING_STEPS.includes(r.step) && options.trackingEnabled === false
      ? ('tracking-disabled' as const)
      : null;
  };
  const retiredSteps = all.flatMap((r) => {
    const reason = retiredReason(r);
    return reason ? [{ step: r.step, reason }] : [];
  });
  const rows = all.filter((r) => !retiredReason(r));
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
  const [jobs] = await client.$queryRaw<
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
        await client.$queryRaw<{ pending: bigint; oldest: number | null }[]>`
          SELECT COUNT(*) AS pending, EXTRACT(EPOCH FROM (clock_timestamp() - MIN(o."createdAt")))::float8 AS oldest
          FROM "OutboxEvent" o JOIN "AuditEvent" a ON a."id"=o."eventId"
          WHERE a."eventType" LIKE 'work.%' AND NOT EXISTS (SELECT 1 FROM "NotificationDispatch" d WHERE d."outboxEventId"=o."id")`
      )[0]
    : null;
  const commitmentOverdueSeconds = options.commitmentOverdueSeconds ?? COMMITMENT_OVERDUE_SECONDS;
  // Same effective-terms read as the closure pass; an unreadable stored deadline is that pass's own failure to report.
  const [commitmentRow] = await client.$queryRaw<{ past: bigint; oldest: number | null }[]>`
    WITH t AS MATERIALIZED (
      SELECT raid_try_timestamptz(raid_effective_terms(e."id")->'deadlines'->>'operationalClosure') AS due
      FROM "Engagement" e WHERE e."state" IN ('ACCESS_PENDING','IN_PROGRESS','SUBMITTED','REVISION_REQUESTED'))
    SELECT COUNT(*) FILTER (WHERE due <= clock_timestamp()) AS past,
      EXTRACT(EPOCH FROM (clock_timestamp() - MIN(due) FILTER (WHERE due <= clock_timestamp())))::float8 AS oldest
    FROM t`;
  // Signed transactions and submitted launches whose chain outcome the reconcilers have not yet recorded.
  const [txRow] = await client.$queryRaw<{ pending: bigint; oldest: number | null }[]>`
    SELECT COUNT(*) AS pending, EXTRACT(EPOCH FROM ((NOW() AT TIME ZONE 'UTC') - MIN(p."at")))::float8 AS oldest
    FROM (SELECT "createdAt" AS "at" FROM "FinancialTx" WHERE "status"='SIGNED'
      UNION ALL SELECT "updatedAt" FROM "TokenLaunch" WHERE "status"='SUBMITTED') p`;
  // Provider freshness is judged only for work the schedule actually collects: active, visible, not suspended, and
  // (for tracking v2) only while tracking is on. X is judged only while collection is switched on.
  const trackingOn = options.trackingEnabled !== false;
  const collectionEnabled =
    (
      await client.settings.findUnique({
        where: { id: 'global' },
        select: { collectionEnabled: true },
      })
    )?.collectionEnabled ?? false;
  const [xRow] = collectionEnabled
    ? await client.$queryRaw<{ active: bigint; stale: bigint; oldest: number | null }[]>`
        SELECT COUNT(*) AS active, COUNT(*) FILTER (WHERE a."age" > ${PROVIDER_STALE_SECONDS}) AS stale, MAX(a."age") AS oldest
        FROM (SELECT EXTRACT(EPOCH FROM ((NOW() AT TIME ZONE 'UTC') - COALESCE(r."observedAt", r."startsAt")))::float8 AS "age"
          FROM "Raid" r JOIN "User" u ON u."id"=r."creatorId"
          WHERE r."status"='ACTIVE' AND r."hidden"=false AND u."suspended"=false AND (r."trackingVersion"<>2 OR ${trackingOn})) a`
    : [];
  const [marketRow] = await client.$queryRaw<
    { active: bigint; stale: bigint; oldest: number | null }[]
  >`
    SELECT COUNT(*) AS active, COUNT(*) FILTER (WHERE a."age" > ${PROVIDER_STALE_SECONDS}) AS stale, MAX(a."age") AS oldest
    FROM (SELECT EXTRACT(EPOCH FROM ((NOW() AT TIME ZONE 'UTC') - COALESCE(t."marketAt", MIN(r."startsAt"))))::float8 AS "age"
      FROM "Token" t JOIN "Raid" r ON r."mint"=t."mint" JOIN "User" u ON u."id"=r."creatorId"
      WHERE r."status"='ACTIVE' AND r."hidden"=false AND u."suspended"=false AND (r."trackingVersion"<>2 OR ${trackingOn})
      GROUP BY t."mint", t."marketAt") a`;
  const commitments = {
    closureEnabled: !!options.closureEnabled,
    pastDeadline: Number(commitmentRow.past),
    oldestPastDeadlineSeconds: seconds(commitmentRow.oldest),
  };
  const transactions = {
    pending: Number(txRow.pending),
    oldestPendingAgeSeconds: seconds(txRow.oldest),
  };
  const providers = {
    collection: {
      enabled: collectionEnabled,
      activeRaids: xRow ? Number(xRow.active) : null,
      staleRaids: xRow ? Number(xRow.stale) : null,
      oldestObservationAgeSeconds: xRow ? seconds(xRow.oldest) : null,
    },
    market: {
      activeTokens: Number(marketRow.active),
      staleTokens: Number(marketRow.stale),
      oldestAgeSeconds: seconds(marketRow.oldest),
    },
  };
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
    ...(commitments.closureEnabled &&
    commitments.oldestPastDeadlineSeconds !== null &&
    commitments.oldestPastDeadlineSeconds >= commitmentOverdueSeconds
      ? ['commitment-deadline-overdue']
      : []),
    ...((transactions.oldestPendingAgeSeconds ?? 0) > TX_UNKNOWN_SECONDS
      ? ['tx-unknown-overdue']
      : []),
    ...(providers.collection.staleRaids ? ['provider-stale:x'] : []),
    ...(providers.market.staleTokens ? ['provider-stale:market'] : []),
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
    retiredSteps,
    commitments,
    transactions,
    providers,
    jobs: {
      oldestRunnableAgeSeconds,
      staleLeases: Number(jobs.stale),
      deadLettered: Number(jobs.dead),
      exhausted: Number(jobs.exhausted),
    },
    outbox: outboxSummary,
  };
}
