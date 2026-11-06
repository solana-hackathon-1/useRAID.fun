import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

/**
 * Worker log correlation (T038 W03, blueprint §27/§30). One opaque id ties a job's attempts, a schedule run's steps and
 * the health-store log lines together. Host contract: none beyond Node. The id is generated here, never derived from
 * payloads, keys, leases or error text, and only ids of a fixed safe shape can be set, so a correlated log line can
 * never carry free text. Diagnostic only: nothing reads it to make a decision.
 */
const SAFE_ID = /^[a-z]+-[A-Za-z0-9]{3,40}$/;
const scope = new AsyncLocalStorage<string>();
/** Run `fn` with every worker log line beneath it carrying `id`. Throws on an id that is not of the safe shape. */
export function withCorrelation<T>(id: string, fn: () => Promise<T>): Promise<T> {
  if (!SAFE_ID.test(id)) throw new TypeError('Invalid correlation id.');
  return scope.run(id, fn);
}
/** `{ correlationId }` inside a correlated scope, `{}` outside: spread it into a log object. */
export function correlationFields(): { correlationId?: string } {
  const correlationId = scope.getStore();
  return correlationId ? { correlationId } : {};
}
/** One id per `schedule()` run, shared by all of its step and health logs. */
export function newRunCorrelationId() {
  return `run-${randomBytes(6).toString('hex')}`;
}
/** Stable across every attempt of one job: the job id is the only identifier used. */
export function jobCorrelationId(jobId: string) {
  return `job-${jobId}`;
}
