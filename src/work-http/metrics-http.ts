import { InternalId } from '../contracts/ids';
import { createErrorEnvelope, type ErrorCode } from '../contracts/protocol';
import { WorkError } from '../work-loop/contracts';
import { WorkMetricsSchema } from '../work-loop/metrics-contracts';
import { WorkHttpError } from './workspace-http';

/** Transport-neutral host: it owns the flag, operator authority, rate limit and SQL. Read only. */
export interface MetricsHttpHost {
  readonly version: 'v1';
  requestId(): string;
  available(): boolean;
  /** Resolves with the operator's account id only for an authorized operator; otherwise rejects with `WorkHttpError`. */
  authorize(request: Request): Promise<string>;
  /** Throttles per operator; rejects with `WorkHttpError(429)`. */
  rateLimit(operatorAccountId: string): Promise<void>;
  metrics(): Promise<unknown>;
}
const headers = Object.freeze({ 'Cache-Control': 'private, no-store', Vary: 'Cookie' });
const respond = (code: ErrorCode, id: string) => {
  const result = createErrorEnvelope(code, id);
  return Response.json(result.body, { status: result.status, headers });
};
export function createMetricsHandlers(host: MetricsHttpHost) {
  if (
    host?.version !== 'v1' ||
    ['requestId', 'available', 'authorize', 'rateLimit', 'metrics'].some(
      (name) => typeof host[name as keyof MetricsHttpHost] !== 'function',
    )
  )
    throw new WorkError('STORAGE_CONTRACT');
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
        if (!operator.success) throw new WorkError('STORAGE_CONTRACT');
        await host.rateLimit(operator.data);
        if (new URL(request.url).searchParams.size) return respond('INVALID_COMMAND', id);
        const metrics = WorkMetricsSchema.safeParse(await host.metrics());
        // A host result outside the strict schema (for example a stray valuation) is never forwarded.
        return metrics.success
          ? Response.json(metrics.data, { headers })
          : respond('SERVICE_UNAVAILABLE', id);
      } catch (error) {
        if (error instanceof WorkHttpError)
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
