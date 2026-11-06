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
}
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
 * Engagements already handled in this pass are excluded, so the pass moves past a failing row to the next candidate.
 */
async function selectCandidates(tx: Tx, handled: string[], want: number): Promise<Candidate[]> {
  return tx.query<Candidate>(
    `WITH t AS MATERIALIZED (SELECT e."id",e."revision",x."raw",raid_try_timestamptz(x."raw") AS "due" FROM "Engagement" e CROSS JOIN LATERAL (SELECT raid_effective_terms(e."id")->'deadlines'->>'operationalClosure' AS "raw") x WHERE e."state" IN ${ACTIVE} AND NOT (e."id"=ANY(string_to_array($1,',')::uuid[]))) SELECT "id"::text AS "engagementId","revision","due" IS NULL AS "invalid" FROM t WHERE "raw" IS NOT NULL AND ("due" IS NULL OR "due"<=clock_timestamp()) ORDER BY "due" NULLS FIRST,"id" LIMIT ${want}`,
    [handled.join(',')],
  );
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
    return { actor, first: await selectCandidates(tx, handled, limit) };
  });
  const result: ClosurePassResult = { considered: 0, closed: 0, skipped: [], failed: [] };
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
        result.failed.push({ engagementId, code: 'TERMS_INVALID' });
        continue;
      }
      // Deterministic per observed revision: a retried or concurrent pass replays the first outcome.
      const key = `closure:${engagementId}:${revision}`;
      try {
        const closed = await ports.run((tx) =>
          closeOverdueEngagement(
            tx,
            {
              actor,
              input: { engagementId, expectedRevision: revision },
              idempotencyKey: key,
              requestId: key,
            },
            ports.host,
          ),
        );
        if (closed.status === 'EXECUTED') result.closed++;
        else result.skipped.push({ engagementId, code: 'REPLAYED' });
      } catch (error) {
        const code =
          error instanceof WorkError
            ? error.code
            : typeof (error as { code?: unknown })?.code === 'string'
              ? (error as { code: string }).code
              : 'STORAGE_UNAVAILABLE';
        (BENIGN.has(code) ? result.skipped : result.failed).push({ engagementId, code });
      }
    }
    const want = limit - (result.closed + result.skipped.length);
    if (want < 1) break;
    candidates = await ports.run((tx) => selectCandidates(tx, handled, want));
  }
  return result;
}
