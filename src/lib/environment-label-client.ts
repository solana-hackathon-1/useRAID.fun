import type { EnvironmentLabelValue } from '@/components/environment-label';

/**
 * Browser-side read of the validated deployment label for `global-error`, which replaces the root layout and so
 * cannot receive the Shell's server-computed prop. Returns null for production and for any failed or unexpected
 * answer: it never invents an environment, so only a confirmed non-production reply shows a label.
 */
export async function fetchEnvironmentLabel(
  request: typeof fetch = fetch,
): Promise<EnvironmentLabelValue | null> {
  try {
    const response = await request('/api/environment', { cache: 'no-store' });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return null;
    const { production, declared, label, network } = body as Record<string, unknown>;
    if (production !== false || typeof declared !== 'boolean' || typeof label !== 'string')
      return null;
    // An unknown network value is dropped, not guessed: the label still shows, without a network.
    if (network === 'devnet' || network === 'mainnet' || network === 'unconfigured')
      return { label, declared, network };
    return { label, declared };
  } catch {
    return null;
  }
}
