/**
 * Which deployment this server is, for the persistent non-production label (blueprint §30.1, T037).
 *
 * `RAID_ENVIRONMENT` must be exactly `production` (case and surrounding space ignored) to hide the label.
 * Unset, empty or unrecognised values fail safe: the label stays visible as "Environment not declared", so a
 * forgotten setting can never make a staging, pilot, alpha or demo deployment look like production. Demo and
 * studio-sandbox mode also win over a declared `production`, because those are contradictory settings.
 * This is a display signal only: it grants no authority and enables no financial or provider gate.
 */
export type DeploymentEnvironment = { production: boolean; declared: boolean; label: string };

const LABELS: Record<string, string> = {
  staging: 'Staging',
  pilot: 'Pilot',
  alpha: 'Alpha',
  demo: 'Demo',
  local: 'Local development',
};

export function deploymentEnvironment(
  env: Record<string, string | undefined> = process.env,
): DeploymentEnvironment {
  const value = (env.RAID_ENVIRONMENT ?? '').trim().toLowerCase();
  if (env.DEMO_MODE === 'true') return { production: false, declared: true, label: LABELS.demo };
  if (env.STUDIO_SANDBOX === 'true')
    return { production: false, declared: true, label: LABELS.local };
  if (value === 'production') return { production: true, declared: true, label: 'Production' };
  const label = Object.hasOwn(LABELS, value) ? LABELS[value] : undefined;
  if (label) return { production: false, declared: true, label };
  return { production: false, declared: false, label: 'Environment not declared' };
}
