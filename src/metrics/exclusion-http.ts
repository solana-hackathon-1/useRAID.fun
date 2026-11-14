import { CommandReceiptError } from '../command-receipts';
import { InternalId } from '../contracts/ids';
import { createErrorEnvelope, type ErrorCode } from '../contracts/protocol';
import { readBoundedJson, JsonBodyFailure } from '../http-contracts/json';
import { MetricsError } from './contracts';
import { MetricsExclusionOutcomeSchema, SetMetricsExclusionInputSchema } from './exclusion';
import { MetricsHttpError } from './http';

/**
 * Transport-neutral host for setting a metrics exclusion marker (DEC-2026-11-13-10). The host owns the flag, the
 * same-origin rule, operator authority, the throttle and the transaction; this module owns the contract. The operator
 * is never taken from the body: `set` receives only the account id `authorize` resolved.
 */
export interface MetricsExclusionHttpHost {
  readonly version: 'v1';
  requestId(): string;
  available(): boolean;
  /** Rejects with `MetricsHttpError(403)` for a request that is not same-origin. */
  checkOrigin(request: Request): void;
  /** Resolves with the account id only for an authorized operator; otherwise rejects with `MetricsHttpError`. */
  authorize(request: Request): Promise<string>;
  rateLimit(operatorAccountId: string): Promise<void>;
  /** Runs the idempotent command as `operatorAccountId`; `requestId` correlates its audit event. */
  set(
    operatorAccountId: string,
    input: ReturnType<typeof SetMetricsExclusionInputSchema.parse>,
    idempotencyKey: string,
    requestId: string,
  ): Promise<unknown>;
}
const headers = Object.freeze({ 'Cache-Control': 'private, no-store', Vary: 'Cookie' });
const respond = (code: ErrorCode, id: string, status?: number) => {
  const result = createErrorEnvelope(code, id);
  return Response.json(result.body, { status: status ?? result.status, headers });
};
export function createMetricsExclusionHandlers(host: MetricsExclusionHttpHost) {
  if (
    host?.version !== 'v1' ||
    ['requestId', 'available', 'checkOrigin', 'authorize', 'rateLimit', 'set'].some(
      (name) => typeof host[name as keyof MetricsExclusionHttpHost] !== 'function',
    )
  )
    throw new MetricsError('STORAGE_CONTRACT');
  return {
    async POST(request: Request) {
      let id = crypto.randomUUID();
      try {
        const supplied = InternalId.safeParse(host.requestId());
        if (supplied.success) id = supplied.data;
        if (request.method !== 'POST')
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
        host.checkOrigin(request);
        const operator = InternalId.safeParse(await host.authorize(request));
        if (!operator.success) throw new MetricsError('STORAGE_CONTRACT');
        await host.rateLimit(operator.data);
        // Authority comes first: a caller who is not an operator never has a body read.
        const key = InternalId.safeParse(request.headers.get('idempotency-key'));
        if (!key.success) return respond('INVALID_COMMAND', id);
        const input = SetMetricsExclusionInputSchema.safeParse(await readBoundedJson(request));
        if (!input.success) return respond('INVALID_COMMAND', id);
        const outcome = MetricsExclusionOutcomeSchema.safeParse(
          await host.set(operator.data, input.data, key.data, id),
        );
        // 201 for a new marker, 200 for an idempotent replay of the same command.
        return outcome.success
          ? Response.json(outcome.data.marker, {
              status: outcome.data.status === 'REPLAYED' ? 200 : 201,
              headers,
            })
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
        if (error instanceof JsonBodyFailure) return respond('INVALID_COMMAND', id, error.status);
        if (error instanceof CommandReceiptError && error.code === 'IDEMPOTENCY_KEY_REUSED')
          return respond('IDEMPOTENCY_KEY_REUSED', id);
        if (error instanceof MetricsError) {
          if (error.code === 'FORBIDDEN') return respond('FORBIDDEN', id);
          if (error.code === 'SUBJECT_NOT_FOUND') return respond('NOT_FOUND', id);
          if (error.code === 'CONFLICT') return respond('REVISION_CHANGED', id);
          if (error.code === 'INVALID_INPUT') return respond('INVALID_COMMAND', id);
        }
        return respond('SERVICE_UNAVAILABLE', id);
      }
    },
  };
}
