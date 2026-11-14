import { randomUUID } from 'node:crypto';
import { requireUser, rateLimit, checkOrigin, HttpError } from './auth';
import { MetricsHttpError } from '../metrics/http';
import { createMetricsExclusionHandlers } from '../metrics/exclusion-http';
import { productMetricsAvailable } from './product-metrics-host';
import { setMetricsExclusionFromHost } from './metrics-exclusion-host';

function authority<T>(work: () => Promise<T> | T): Promise<T> {
  return Promise.resolve()
    .then(work)
    .catch((error: unknown) => {
      if (error instanceof HttpError && [401, 403, 429].includes(error.status))
        throw new MetricsHttpError(error.status as 401 | 403 | 429);
      throw error;
    });
}
export const metricsExclusionHandlers = createMetricsExclusionHandlers({
  version: 'v1',
  requestId: randomUUID,
  // Same exact-string flag as the product-metrics read: markers exist only where that report does.
  available: productMetricsAvailable,
  checkOrigin: (request) => {
    try {
      checkOrigin(request);
    } catch (error) {
      if (error instanceof HttpError && error.status === 403) throw new MetricsHttpError(403);
      throw error;
    }
  },
  // The shared administrator rule (environment allowlist, X sign-in), enforced on every request.
  authorize: () => authority(async () => (await requireUser(true)).id),
  rateLimit: (operator) => authority(() => rateLimit('metrics-exclusion:' + operator, 20, 60)),
  set: (operator, input, key, requestId) =>
    setMetricsExclusionFromHost(operator, input, key, requestId),
});
