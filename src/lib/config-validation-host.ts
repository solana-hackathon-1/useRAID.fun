import { operatorLogLine } from './operator-log';
import { ConfigRefusedError, assertRuntimeConfig, type ConfigRole } from '../config-validation';

/**
 * Root host for the T037 runtime configuration validator. Web calls it from `instrumentation.ts` and the
 * worker from `worker.ts`, before any request, schema check or job. A refusal throws
 * `ConfigRefusedError` (variable names and codes only); warnings are logged once as names and codes. It
 * never changes the environment.
 *
 * `checkRuntimeConfigOrExit` is the web entry (DEC-2026-11-07-01 f): a refused process logs one value-free
 * JSON line and exits with code 1 at start, so a bad deployment is visible to the orchestrator instead of
 * staying up and answering every request with 500. The worker keeps the throwing form and exits on it.
 */
export function checkRuntimeConfig(
  role: ConfigRole,
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const warnings = assertRuntimeConfig(env, role);
  for (const warning of warnings)
    console.warn(JSON.stringify({ config: 'warning', role, ...warning }));
  return warnings;
}

export function checkRuntimeConfigOrExit(
  role: ConfigRole,
  env: Readonly<Record<string, string | undefined>> = process.env,
  exit: (code: number) => never = process.exit,
) {
  try {
    return checkRuntimeConfig(role, env);
  } catch (error) {
    if (!(error instanceof ConfigRefusedError)) throw error;
    // Code plus safe class and the violation codes only (DEC-2026-11-07-01 d); subjects and values never reach the log.
    console.error(operatorLogLine('config-refused', error, { role }));
    return exit(1);
  }
}
