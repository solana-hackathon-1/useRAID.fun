/** Validates configuration once when a Next.js server starts (T037); a refusal fails every request, it does not exit the process. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { checkRuntimeConfig } = await import('./lib/config-validation-host');
  checkRuntimeConfig('web');
}
