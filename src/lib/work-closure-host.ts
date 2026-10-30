import type { WorkCommand } from '../work-loop/contracts';
import type { ClosureHost } from '../work-loop/closure-contracts';
import { closeOverdueEngagement } from '../work-loop/closure-storage';
import { closeOverdueBatch } from '../work-loop/closure-pass';
import { workClosureEnabled } from './config';
import { runCommandTransaction } from './command-receipts-adapter';
import { isWorkOperator } from './work-workspace-host';
import { db } from './db';

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
/**
 * Worker entry: one bounded pass. Off unless `WORK_CLOSURE_ENABLED` is exactly true and `WORK_CLOSURE_WORKER_ACCOUNT_ID`
 * names an operator account; the pass presents that account's own current Session and fails closed without one.
 * Failures that need an operator are thrown after the pass so the worker logs them.
 */
export async function runWorkClosureWorker() {
  const workerAccountId = (process.env.WORK_CLOSURE_WORKER_ACCOUNT_ID ?? '').trim();
  if (!workClosureEnabled() || !workerAccountId) return null;
  const result = await closeOverdueBatch({
    run: (work) => runCommandTransaction(db, work),
    host: createRootClosureHost(true),
    workerAccountId,
  });
  if (result.failed.length)
    throw new Error(
      `Work closure pass left ${result.failed.length} engagement(s) open: ${[
        ...new Set(result.failed.map((f) => f.code)),
      ].join(',')}`,
    );
  return result;
}
