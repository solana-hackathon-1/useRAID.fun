import { MetricsError } from '../metrics/contracts';
import { setMetricsExclusion, type SetMetricsExclusionInput } from '../metrics/exclusion';
import { runCommandTransaction } from './command-receipts-adapter';
import { db } from './db';
import { productMetricsAvailable } from './product-metrics-host';

/** Sets one marker as an already-authorized operator, in one transaction, only while the metrics flag is on. */
export function setMetricsExclusionFromHost(
  operatorAccountId: string,
  input: SetMetricsExclusionInput,
  idempotencyKey: string,
  requestId: string,
) {
  if (!productMetricsAvailable()) throw new MetricsError('STORAGE_CONTRACT');
  return runCommandTransaction(db, (tx) =>
    setMetricsExclusion(tx, { operatorAccountId, input, idempotencyKey, requestId }),
  );
}
