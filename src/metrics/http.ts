import { InternalId } from '../contracts/ids';
import { createErrorEnvelope, type ErrorCode } from '../contracts/protocol';
import { MetricsError, ProductMetricsSchema } from './contracts';

export { MetricsError } from './contracts';
/** A host maps its own 401/403/429 authority failures to this so the module stays free of host auth types. */
export class MetricsHttpError extends Error {
  constructor(readonly status: 401 | 403 | 429) {
    super('HTTP_AUTHORITY_DENIED');
    this.name = 'MetricsHttpError';
  }
}
/** Transport-neutral host: it owns the flag, operator authority, rate limit and SQL. Read only. */
export interface ProductMetricsHttpHost {
  readonly version: 'v1';
  requestId(): string;
  available(): boolean;
  /** Resolves with the operator's account id only for an authorized operator; otherwise rejects with `MetricsHttpError`. */
  authorize(request: Request): Promise<string>;
  /** Throttles per operator; rejects with `MetricsHttpError(429)`. */
  rateLimit(operatorAccountId: string): Promise<void>;
  metrics(): Promise<unknown>;
}
const headers = Object.freeze({ 'Cache-Control': 'private, no-store', Vary: 'Cookie' });
const respond = (code: ErrorCode, id: string) => {
  const result = createErrorEnvelope(code, id);
  return Response.json(result.body, { status: result.status, headers });
};
export function createProductMetricsHandlers(host: ProductMetricsHttpHost) {
  if (
    host?.version !== 'v1' ||
    ['requestId', 'available', 'authorize', 'rateLimit', 'metrics'].some(
      (name) => typeof host[name as keyof ProductMetricsHttpHost] !== 'function',
    )
  )
    throw new MetricsError('STORAGE_CONTRACT');
  return {
    async GET(request: Request) {
      let id = crypto.randomUUID();
      try {
        const supplied = InternalId.safeParse(host.requestId());
        if (supplied.success) id = supplied.data;
        if (request.method !== 'GET')
          return Response.json(
            {
              error: {
                code: 'METHOD_NOT_ALLOWED',
                message: 'Method not allowed.',
                retryable: false,
                requestId: id,
              },
            },
            { status: 405, headers },
          );
        if (!host.available()) return respond('NOT_FOUND', id);
        const operator = InternalId.safeParse(await host.authorize(request));
        if (!operator.success) throw new MetricsError('STORAGE_CONTRACT');
        await host.rateLimit(operator.data);
        if (new URL(request.url).searchParams.size) return respond('INVALID_COMMAND', id);
        const metrics = ProductMetricsSchema.safeParse(await host.metrics());
        // A host result outside the strict schema (for example a stray valuation) is never forwarded.
        return metrics.success
          ? Response.json(metrics.data, { headers })
          : respond('SERVICE_UNAVAILABLE', id);
      } catch (error) {
        if (error instanceof MetricsHttpError)
          return respond(
            error.status === 401
              ? 'AUTHENTICATION_REQUIRED'
              : error.status === 403
                ? 'FORBIDDEN'
                : 'RATE_LIMITED',
            id,
          );
        return respond('SERVICE_UNAVAILABLE', id);
      }
    },
  };
}
