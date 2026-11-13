import { WorkError, type WorkCommand } from '../work-loop/contracts';
import type { ClosureHost } from '../work-loop/closure-contracts';
import { closeOverdueEngagement } from '../work-loop/closure-storage';
import { closeOverdueBatch } from '../work-loop/closure-pass';
import { workClosureEnabled } from './config';
import { runCommandTransaction } from './command-receipts-adapter';
import { isWorkOperator } from './work-workspace-host';
import { db } from './db';
import { correlationFields } from './worker-diagnostics';

/**
 * Closure host for the shared Root. Operations authority is the explicit synthetic operator allowlist
 * (`RAID_WORK_OPERATOR_ACCOUNT_IDS`): the Root has no recognized Guild authority yet, so this is NOT Guild or
 * production authority and the Guild id is deliberately ignored. With the variable unset nobody can close work.
 */
export function createRootClosureHost(
  allowNewWrites: boolean,
  isOperator: (accountId: string) => boolean = isWorkOperator,
): ClosureHost {
  return {
    allowNewWrites,
    authorize: async (_tx, actor) => isOperator(actor.accountId),
  };
}
/** HTTP entry. `WORK_CLOSURE_ENABLED` is the only write switch; a replay of an earlier closure is still answered. */
export async function closeEngagementFromHost(command: WorkCommand) {
  const host = createRootClosureHost(workClosureEnabled());
  return runCommandTransaction(db, (tx) => closeOverdueEngagement(tx, command, host));
}
/** A persistent missing-session outage is raised again after this long, so one lost log line cannot hide it. */
export const WORK_CLOSURE_REALARM_MS = 15 * 60 * 1000;
let sessionOutageReportedAt: number | null = null;
/**
 * Worker entry: one bounded pass. Off unless `WORK_CLOSURE_ENABLED` is exactly true and `WORK_CLOSURE_WORKER_ACCOUNT_ID`
 * names an operator account; the pass presents that account's own current Session and fails closed without one.
 * Failures that need an operator are thrown after the pass so the worker logs them; a missing worker session is
 * thrown once per outage (the pass keeps failing closed), again every `WORK_CLOSURE_REALARM_MS` while it persists, and
 * again after it has recovered. The injectable clock is for tests.
 */
export async function runWorkClosureWorker(now: () => number = Date.now) {
  const workerAccountId = (process.env.WORK_CLOSURE_WORKER_ACCOUNT_ID ?? '').trim();
  if (!workClosureEnabled() || !workerAccountId) return null;
  let result;
  try {
    result = await closeOverdueBatch({
      run: (work) => runCommandTransaction(db, work),
      host: createRootClosureHost(true),
      workerAccountId,
    });
  } catch (error) {
    // No live session for the worker account: the pass fails closed on every tick. Raise it once per outage and then
    // at a bounded interval, so the log stays readable but a lost line cannot hide a persistent outage; any other
    // failure is always raised.
    if (error instanceof WorkError && error.code === 'UNAUTHENTICATED') {
      const at = now();
      if (
        sessionOutageReportedAt !== null &&
        at - sessionOutageReportedAt < WORK_CLOSURE_REALARM_MS
      )
        return null;
      sessionOutageReportedAt = at;
    }
    throw error;
  }
  sessionOutageReportedAt = null;
  // One alert per engagement when it reaches the stuck threshold (code and counts only, never error text); the pass
  // keeps retrying it at the back-off cap, and worker health keeps showing it until it closes or leaves the active states.
  for (const s of result.stuck ?? [])
    console.error(
      JSON.stringify({
        alert: 'work-closure-stuck',
        engagementId: s.engagementId,
        code: s.code,
        failures: s.failures,
        ...correlationFields(),
      }),
    );
  if (result.failed.length)
    throw new Error(
      `Work closure pass left ${result.failed.length} engagement(s) open: ${[
        ...new Set(result.failed.map((f) => f.code)),
      ].join(',')}`,
    );
  return result;
}
