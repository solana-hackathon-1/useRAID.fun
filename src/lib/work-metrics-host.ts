import { WorkError } from '../work-loop/contracts';
import { readWorkMetrics } from '../work-loop/metrics-storage';
import { runCommandTransaction } from './command-receipts-adapter';
import { db } from './db';

/** Exact-string flag, default off. Operator authority is enforced separately by the HTTP host. */
export function workMetricsAvailable() {
  return process.env.WORK_METRICS_READS_ENABLED === 'true';
}
export async function readMetricsFromHost() {
  if (!workMetricsAvailable()) throw new WorkError('STORAGE_CONTRACT');
  return runCommandTransaction(db, (tx) => readWorkMetrics(tx));
}
