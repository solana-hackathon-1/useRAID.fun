/** Validates configuration once when a Next.js server starts (T037); refusal prevents serving. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { checkRuntimeConfig } = await import('./lib/config-validation-host');
  checkRuntimeConfig('web');
}
