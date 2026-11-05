import { randomUUID } from 'node:crypto';
import { requireUser, rateLimit, HttpError } from './auth';
import { createProductMetricsHandlers, MetricsHttpError } from '../metrics/http';
import { readProductMetricsFromHost, productMetricsAvailable } from './product-metrics-host';

async function authority<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpError && [401, 403, 429].includes(error.status))
      throw new MetricsHttpError(error.status as 401 | 403 | 429);
    throw error;
  }
}
export const productMetricsHandlers = createProductMetricsHandlers({
  version: 'v1',
  requestId: randomUUID,
  available: productMetricsAvailable,
  // The shared administrator rule: an X-signed-in administrator, never a wallet-only session.
  authorize: () => authority(async () => (await requireUser(true)).id),
  rateLimit: (operator) => authority(() => rateLimit('product-metrics:' + operator, 30, 60)),
  metrics: readProductMetricsFromHost,
});
