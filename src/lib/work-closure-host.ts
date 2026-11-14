import type { WorkCommand } from '../work-loop/contracts';
import { WORK_CLOSURE_PRINCIPAL, type ClosureHost } from '../work-loop/closure-contracts';
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
    // A human is recognized by `accountId` first (storage passes humans only `{accountId, sessionHash}`), so an actor
    // that also carries a `principal` key is still checked against the operator allowlist. The service principal has
    // no account, is authorized for the worker's timeout closure only (the storage command refuses it anything else)
    // and is not on the operator allowlist.
    authorize: async (_tx, actor) =>
      'accountId' in actor
        ? isOperator(actor.accountId)
        : actor.principal === WORK_CLOSURE_PRINCIPAL,
  };
}
/** HTTP entry. `WORK_CLOSURE_ENABLED` is the only write switch; a replay of an earlier closure is still answered. */
export async function closeEngagementFromHost(command: WorkCommand) {
  const host = createRootClosureHost(workClosureEnabled());
  return runCommandTransaction(db, (tx) => closeOverdueEngagement(tx, command, host));
}
/**
 * Worker entry: one bounded pass. Off unless `WORK_CLOSURE_ENABLED` is exactly true. The pass acts as the credential-less
 * `work-closure` service principal (DEC-2026-11-14-08), so it needs no account, Session or allowlist entry, and the
 * retired `WORK_CLOSURE_WORKER_ACCOUNT_ID` is ignored. Failures that need an operator are thrown after the pass so the
 * worker logs them.
 */
export async function runWorkClosureWorker() {
  if (!workClosureEnabled()) return null;
  const result = await closeOverdueBatch({
    run: (work) => runCommandTransaction(db, work),
    host: createRootClosureHost(true),
    // Value-free lines (ids, codes, counts) are written when they happen, not after the pass.
    log: (line) => console.error(JSON.stringify({ ...line, ...correlationFields() })),
  });
  // The stuck alert (one per engagement, at the 10th consecutive failure) was logged by the pass itself. Systemic
  // refusals are not backed off per engagement; the single summary below, codes only, is their one log line.
  if (result.failed.length)
    throw new Error(
      `Work closure pass left ${result.failed.length} engagement(s) open: ${[
        ...new Set(result.failed.map((f) => f.code)),
      ].join(',')}`,
    );
  return result;
}
