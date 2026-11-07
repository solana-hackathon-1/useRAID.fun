/**
 * Operator-log redaction (DEC-2026-11-07-01 d, blueprint §28/§30.1). A log line about a failure carries a stable
 * `code` plus a safe `errorClass` and nothing else: never the error message, stack, cause, a property value or a
 * thrown non-Error value, because those carry database URLs, provider bodies, signatures and keys. Host contract: none
 * beyond Node; this module imports only `zod`. Diagnostic only - nothing reads these fields to decide.
 *
 * `code` is, in order: `VALIDATION` for a Zod error; an uppercase code of fixed shape on the error (a Prisma `P2002`,
 * a Node `ECONNREFUSED`, an application code); `HTTP_<status>` for a numeric status of 100-599 (HttpError, a provider
 * error); otherwise `UNCLASSIFIED`. `errorClass` is the error's class name when it is a plain identifier, else `Error`.
 * Anything not of those shapes is dropped, so free text can never reach the line.
 */
import { ZodError } from 'zod';

export interface OperatorErrorFields {
  code: string;
  errorClass: string;
}
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,39}$/;
const SAFE_CLASS = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const UNKNOWN: OperatorErrorFields = { code: 'UNCLASSIFIED', errorClass: 'Error' };

export function operatorErrorFields(error: unknown): OperatorErrorFields {
  try {
    if (error instanceof ZodError) return { code: 'VALIDATION', errorClass: 'ZodError' };
    if (!(error instanceof Error)) return { ...UNKNOWN };
    const name = error.name !== 'Error' ? error.name : error.constructor?.name;
    const errorClass = typeof name === 'string' && SAFE_CLASS.test(name) ? name : 'Error';
    const { code, status } = error as { code?: unknown; status?: unknown };
    if (typeof code === 'string' && SAFE_CODE.test(code)) return { code, errorClass };
    if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599)
      return { code: `HTTP_${status}`, errorClass };
    return { code: UNKNOWN.code, errorClass };
  } catch {
    return { ...UNKNOWN };
  }
}
/** One JSON line for `console.error`: `{ event, ...context, code, errorClass }`. Context must be ids and fixed words. */
export function operatorLogLine(
  event: string,
  error: unknown,
  context: Record<string, string | number | boolean | undefined> = {},
) {
  return JSON.stringify({ event, ...context, ...operatorErrorFields(error) });
}
