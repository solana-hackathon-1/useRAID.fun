import type { CommandReceiptTransaction as Tx } from '../command-receipts';
import { WorkError, type WorkActor } from './contracts';
import type { ClosureHost } from './closure-contracts';
import { closeOverdueEngagement } from './closure-storage';

/**
 * Explicit host dependencies of one scheduled closure pass. The host owns the transaction runner (each call must be an
 * independent whole transaction that retries itself on deadlock or serialization failure), the operations authority
 * and the single account the pass acts as. No ambient configuration is read here.
 */
export interface ClosurePassPorts {
  run<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
  host: ClosureHost;
  /** The operations account whose current canonical Session the pass presents; it must also pass `host.authorize`. */
  workerAccountId: string;
  /** Engagements closed or settled per pass (1–100, default 25), oldest deadline first. */
  limit?: number;
  /**
   * Failing engagements one pass steps over before it stops (1–100, default 100). A failing row does not use up
   * `limit`, so persistently failing old rows cannot starve newer ones until more than this many fail at once.
   */
  maxFailures?: number;
}
export interface ClosurePassResult {
  considered: number;
  closed: number;
  /** Not closed because another writer already decided it, it moved on, or the receipt replayed: benign. */
  skipped: { engagementId: string; code: string }[];
  /** Refused or failed for a reason an operator must look at. */
  failed: { engagementId: string; code: string }[];
  /** Engagements that reached the stuck threshold in this pass: raise one operator alert each (code and counts only). */
  stuck: { engagementId: string; code: string; failures: number }[];
}
/** Durable back-off (DEC-2026-11-13-06 a, provisional): 1 minute, doubling per consecutive failure, capped at 1 hour. */
export const CLOSURE_BACKOFF_BASE_SECONDS = 60;
export const CLOSURE_BACKOFF_CAP_SECONDS = 3600;
/** Consecutive failures after which one `work-closure-stuck` alert is raised; retrying continues at the cap. */
export const CLOSURE_STUCK_FAILURES = 10;
/** Another writer reached a settled answer first; nothing is wrong and the next pass will not see it again. */
const BENIGN = new Set(['ENGAGEMENT_STATE', 'REVISION_CONFLICT', 'DEADLINE_NOT_REACHED']);
const ACTIVE = "('ACCESS_PENDING','IN_PROGRESS','SUBMITTED','REVISION_REQUESTED')";
interface Candidate {
  engagementId: string;
  revision: number;
  /** The stored operational deadline exists but is not a readable timestamp. */
  invalid: boolean;
}
/**
 * Oldest overdue first. The effective terms are read once per active engagement (MATERIALIZED, so the planner cannot
 * re-evaluate them per use) and an unreadable stored deadline becomes `invalid` instead of aborting the statement.
 * Engagements already handled in this pass are excluded, so the pass moves past a failing row to the next candidate;
 * engagements still inside their durable back-off are not candidates at all.
 */
async function selectCandidates(tx: Tx, handled: string[], want: number): Promise<Candidate[]> {
  return tx.query<Candidate>(
    `WITH t AS MATERIALIZED (SELECT e."id",e."revision",x."raw",raid_try_timestamptz(x."raw") AS "due" FROM "Engagement" e CROSS JOIN LATERAL (SELECT raid_effective_terms(e."id")->'deadlines'->>'operationalClosure' AS "raw") x WHERE e."state" IN ${ACTIVE} AND NOT (e."id"=ANY(string_to_array($1,',')::uuid[])) AND NOT EXISTS (SELECT 1 FROM "EngagementClosureBackoff" k WHERE k."engagementId"=e."id" AND k."nextAttemptAt">clock_timestamp())) SELECT "id"::text AS "engagementId","revision","due" IS NULL AS "invalid" FROM t WHERE "raw" IS NOT NULL AND ("due" IS NULL OR "due"<=clock_timestamp()) ORDER BY "due" NULLS FIRST,"id" LIMIT ${want}`,
    [handled.join(',')],
  );
}
/**
 * Records one failed attempt in its own transaction (the failed attempt's transaction has rolled back) and reports
 * whether this failure is the one that reaches the stuck threshold. Recording is best effort: if it cannot be written
 * the engagement is simply attempted again on the next pass, and the failure is still reported by the pass. Nothing here
 * closes work or releases capacity.
 */
async function recordFailure(ports: ClosurePassPorts, engagementId: string, code: string) {
  try {
    return await ports.run(async (tx) => {
      const [rec] = await tx.query<{ failures: number; alerted: boolean }>(
        `INSERT INTO "EngagementClosureBackoff" ("engagementId","consecutiveFailures","lastFailureCode","nextAttemptAt") SELECT e."id",1,$2,clock_timestamp()+make_interval(secs=>${CLOSURE_BACKOFF_BASE_SECONDS}) FROM "Engagement" e WHERE e."id"=$1::uuid AND e."state" IN ${ACTIVE} ON CONFLICT ("engagementId") DO UPDATE SET "consecutiveFailures"="EngagementClosureBackoff"."consecutiveFailures"+1,"lastFailureCode"=EXCLUDED."lastFailureCode","nextAttemptAt"=clock_timestamp()+make_interval(secs=>LEAST(${CLOSURE_BACKOFF_CAP_SECONDS},${CLOSURE_BACKOFF_BASE_SECONDS}*power(2,LEAST("EngagementClosureBackoff"."consecutiveFailures",20)))),"updatedAt"=clock_timestamp() RETURNING "consecutiveFailures" AS "failures","alertedAt" IS NOT NULL AS "alerted"`,
        [engagementId, code.slice(0, 80)],
      );
      if (!rec || rec.alerted || rec.failures < CLOSURE_STUCK_FAILURES) return null;
      // The upsert holds the row lock, so exactly one pass flips this and raises the alert.
      const flipped = await tx.query(
        `UPDATE "EngagementClosureBackoff" SET "alertedAt"=clock_timestamp() WHERE "engagementId"=$1::uuid AND "alertedAt" IS NULL RETURNING 1 AS "ok"`,
        [engagementId],
      );
      return flipped.length ? rec.failures : null;
    });
  } catch {
    return null;
  }
}
/**
 * One bounded pass: close each active engagement whose accepted operational deadline has passed, each in its own
 * transaction so one refusal never rolls back another closure and a failing row does not block the ones behind it. The command carries the revision the pass read, so a
 * job that is late for an engagement that has since moved on is refused instead of acting on it, and the release
 * matches participant and engagement, so it can never free a newer commitment. Silence decides no money and no fault.
 */
export async function closeOverdueBatch(ports: ClosurePassPorts): Promise<ClosurePassResult> {
  const limit = ports.limit ?? 25;
  const maxFailures = ports.maxFailures ?? 100;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(maxFailures) ||
    maxFailures < 1 ||
    maxFailures > 100 ||
    typeof ports.run !== 'function' ||
    typeof ports.workerAccountId !== 'string' ||
    !ports.workerAccountId
  )
    throw new WorkError('STORAGE_CONTRACT');
  const handled: string[] = [];
  const { actor, first } = await ports.run(async (tx) => {
    const sessions = await tx.query<{ tokenHash: string }>(
      `SELECT "tokenHash" FROM "Session" WHERE "userId"=$1 AND "via" IN ('wallet','x') AND "expiresAt">(clock_timestamp() AT TIME ZONE 'UTC') ORDER BY "expiresAt" DESC LIMIT 1`,
      [ports.workerAccountId],
    );
    if (sessions.length !== 1) throw new WorkError('UNAUTHENTICATED');
    const actor: WorkActor = {
      accountId: ports.workerAccountId,
      sessionHash: sessions[0].tokenHash,
    };
    // A record for an engagement that is no longer active (closed, settled or moved on) has nothing left to retry.
    await tx.query(
      `DELETE FROM "EngagementClosureBackoff" k WHERE NOT EXISTS (SELECT 1 FROM "Engagement" e WHERE e."id"=k."engagementId" AND e."state" IN ${ACTIVE})`,
      [],
    );
    return { actor, first: await selectCandidates(tx, handled, limit) };
  });
  const result: ClosurePassResult = {
    considered: 0,
    closed: 0,
    skipped: [],
    failed: [],
    stuck: [],
  };
  const fail = async (engagementId: string, code: string) => {
    result.failed.push({ engagementId, code });
    const failures = await recordFailure(ports, engagementId, code);
    if (failures !== null) result.stuck.push({ engagementId, code, failures });
  };
  // Bounded and deterministic: at most `limit` engagements closed or settled and at most `maxFailures` failures, so a
  // few persistently failing old rows cannot use up the batch, yet one pass never runs unbounded.
  let candidates = first;
  while (candidates.length > 0 && result.failed.length < maxFailures) {
    for (const { engagementId, revision, invalid } of candidates) {
      if (result.failed.length >= maxFailures) break;
      handled.push(engagementId);
      result.considered++;
      if (invalid) {
        // Closing would hit the same unreadable deadline in the database guard; surface it for an operator.
        await fail(engagementId, 'TERMS_INVALID');
        continue;
      }
      // Deterministic per observed revision: a retried or concurrent pass replays the first outcome.
      const key = `closure:${engagementId}:${revision}`;
      try {
        const closed = await ports.run(async (tx) => {
          const outcome = await closeOverdueEngagement(
            tx,
            {
              actor,
              input: { engagementId, expectedRevision: revision },
              idempotencyKey: key,
              requestId: key,
            },
            ports.host,
          );
          // Reset: a closed engagement keeps no back-off record (same transaction as the closure).
          await tx.query(`DELETE FROM "EngagementClosureBackoff" WHERE "engagementId"=$1::uuid`, [
            engagementId,
          ]);
          return outcome;
        });
        if (closed.status === 'EXECUTED') result.closed++;
        else result.skipped.push({ engagementId, code: 'REPLAYED' });
      } catch (error) {
        const code =
          error instanceof WorkError
            ? error.code
            : typeof (error as { code?: unknown })?.code === 'string'
              ? (error as { code: string }).code
              : 'STORAGE_UNAVAILABLE';
        if (BENIGN.has(code)) result.skipped.push({ engagementId, code });
        else await fail(engagementId, code);
      }
    }
    const want = limit - (result.closed + result.skipped.length);
    if (want < 1) break;
    candidates = await ports.run((tx) => selectCandidates(tx, handled, want));
  }
  return result;
}
