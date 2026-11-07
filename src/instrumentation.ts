import type { Instrumentation } from 'next';
import { operatorLogLine } from './lib/operator-log';

/** Validates configuration once when a Next.js server starts (T037); a refusal fails every request, it does not exit the process. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { checkRuntimeConfig } = await import('./lib/config-validation-host');
  checkRuntimeConfig('web');
}

const SAFE_METHOD = /^[A-Z]{3,10}$/;
const SAFE_ROUTE = /^\/[A-Za-z0-9_\-./[\]()@]{0,199}$/;
const ROUTER_KINDS = ['Pages Router', 'App Router'];
const ROUTE_TYPES = ['render', 'route', 'action', 'proxy'];
const pick = <T extends string>(value: unknown, ok: (v: string) => boolean): T | undefined =>
  typeof value === 'string' && ok(value) ? (value as T) : undefined;

/**
 * Server-side request errors (DEC-2026-11-07-01 d): one operator log line with a code, a safe class and fixed routing
 * fields (method, router kind, route file path, route type). The error message, request path and query, headers and
 * digest are never read. Next prints an uncaught error itself before this hook runs and exposes no switch to suppress
 * that output (`logError` is gated only by the custom-server `quiet` option), so this hook adds the redacted record
 * operators should alert on; it does not replace Next's own line.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  try {
    console.error(
      operatorLogLine('request-error', error, {
        method: pick(request?.method, (v) => SAFE_METHOD.test(v)),
        routerKind: pick(context?.routerKind, (v) => ROUTER_KINDS.includes(v)),
        routeType: pick(context?.routeType, (v) => ROUTE_TYPES.includes(v)),
        routePath: pick(context?.routePath, (v) => SAFE_ROUTE.test(v)),
      }),
    );
  } catch {
    // Logging must never become a second failure inside the error path.
  }
};
