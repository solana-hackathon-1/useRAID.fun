/** Validates configuration once when a Next.js server starts (T037); a refusal logs value-free codes and exits the process with code 1 (DEC-2026-11-07-01 f). */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { checkRuntimeConfigOrExit } = await import('./lib/config-validation-host');
  checkRuntimeConfigOrExit('web');
}
