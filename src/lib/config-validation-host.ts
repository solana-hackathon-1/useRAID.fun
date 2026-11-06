import { assertRuntimeConfig, type ConfigRole } from '../config-validation';

/**
 * Root host for the T037 runtime configuration validator. Web calls it from `instrumentation.ts` and the
 * worker from `worker.ts`, before any request, schema check or job. A refusal throws
 * `ConfigRefusedError` (variable names and codes only): the worker exits, and web stays up answering every request with 500, so nothing is served; warnings
 * are logged once as names and codes. It never changes the environment.
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
