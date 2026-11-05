import { MetricsError } from '../metrics/contracts';
import { readProductMetrics } from '../metrics/storage';
import { runCommandTransaction } from './command-receipts-adapter';
import { db } from './db';

/** Exact-string flag, default off, independent of the work-loop metrics flag. Operator authority is enforced separately. */
export function productMetricsAvailable() {
  return process.env.PRODUCT_METRICS_READS_ENABLED === 'true';
}
export async function readProductMetricsFromHost() {
  if (!productMetricsAvailable()) throw new MetricsError('STORAGE_CONTRACT');
  return runCommandTransaction(db, (tx) => readProductMetrics(tx));
}
