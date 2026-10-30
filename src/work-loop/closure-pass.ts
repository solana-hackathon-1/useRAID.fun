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
  /** Engagements considered per pass (1–100, default 25), oldest deadline first. */
  limit?: number;
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
const DEADLINE = `(raid_effective_terms(e."id")->'deadlines'->>'operationalClosure')::timestamptz`;
/**
 * One bounded pass: close each active engagement whose accepted operational deadline has passed, each in its own
 * transaction so one refusal never rolls back another closure. The command carries the revision the pass read, so a
 * job that is late for an engagement that has since moved on is refused instead of acting on it, and the release
 * matches participant and engagement, so it can never free a newer commitment. Silence decides no money and no fault.
 */
export async function closeOverdueBatch(ports: ClosurePassPorts): Promise<ClosurePassResult> {
  const limit = ports.limit ?? 25;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    typeof ports.run !== 'function' ||
    typeof ports.workerAccountId !== 'string' ||
    !ports.workerAccountId
  )
    throw new WorkError('STORAGE_CONTRACT');
  const { actor, candidates } = await ports.run(async (tx) => {
    const sessions = await tx.query<{ tokenHash: string }>(
      `SELECT "tokenHash" FROM "Session" WHERE "userId"=$1 AND "via" IN ('wallet','x') AND "expiresAt">(clock_timestamp() AT TIME ZONE 'UTC') ORDER BY "expiresAt" DESC LIMIT 1`,
      [ports.workerAccountId],
    );
    if (sessions.length !== 1) throw new WorkError('UNAUTHENTICATED');
    const rows = await tx.query<{ engagementId: string; revision: number }>(
      `SELECT e."id"::text AS "engagementId",e."revision" FROM "Engagement" e WHERE e."state" IN ${ACTIVE} AND ${DEADLINE}<=clock_timestamp() ORDER BY ${DEADLINE},e."id" LIMIT ${limit}`,
      [],
    );
    const actor: WorkActor = {
      accountId: ports.workerAccountId,
      sessionHash: sessions[0].tokenHash,
    };
    return { actor, candidates: rows };
  });
  const result: ClosurePassResult = {
    considered: candidates.length,
    closed: 0,
    skipped: [],
    failed: [],
  };
  for (const { engagementId, revision } of candidates) {
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
  return result;
}
