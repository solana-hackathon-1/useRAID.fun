import { randomUUID } from 'node:crypto';
import { requireUser, rateLimit, HttpError } from './auth';
import { createMetricsHandlers } from '../work-http/metrics-http';
import { WorkHttpError } from '../work-http/workspace-http';
import { readMetricsFromHost, workMetricsAvailable } from './work-metrics-host';

async function authority<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpError && [401, 403, 429].includes(error.status))
      throw new WorkHttpError(error.status as 401 | 403 | 429);
    throw error;
  }
}
export const metricsHandlers = createMetricsHandlers({
  version: 'v1',
  requestId: randomUUID,
  available: workMetricsAvailable,
  // The shared administrator rule: an X-signed-in administrator, never a wallet-only session.
  authorize: () => authority(async () => (await requireUser(true)).id),
  rateLimit: (operator) => authority(() => rateLimit('work-metrics:' + operator, 30, 60)),
  metrics: readMetricsFromHost,
});
