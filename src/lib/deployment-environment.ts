/**
 * Which deployment this server is, for the persistent non-production label (blueprint §30.1, T037).
 *
 * `RAID_ENVIRONMENT` must be exactly `production` (case and surrounding space ignored) to hide the label.
 * Unset, empty or unrecognised values fail safe: the label stays visible as "Environment not declared", so a
 * forgotten setting can never make a staging, pilot, alpha or demo deployment look like production. Demo and
 * studio-sandbox mode also win over a declared `production`, because those are contradictory settings.
 * This is a display signal only: it grants no authority and enables no financial or provider gate.
 */
export type DeploymentNetwork = 'devnet' | 'mainnet' | 'unconfigured';
export type DeploymentEnvironment = {
  production: boolean;
  declared: boolean;
  label: string;
  network: DeploymentNetwork;
};

/**
 * The Solana network indicator (§30.1). The only source is `USDC_NETWORK`, the setting the config validator,
 * wallet sign-in and USDC settings already require to be exactly `devnet` or `mainnet`. Anything else (unset,
 * different case, `testnet`, an RPC URL naming a cluster) is `unconfigured`: this never infers a network.
 */
export function deploymentNetwork(
  env: Record<string, string | undefined> = process.env,
): DeploymentNetwork {
  const value = env.USDC_NETWORK;
  return value === 'devnet' || value === 'mainnet' ? value : 'unconfigured';
}

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
  const network = deploymentNetwork(env);
  const value = (env.RAID_ENVIRONMENT ?? '').trim().toLowerCase();
  if (env.DEMO_MODE === 'true')
    return { production: false, declared: true, label: LABELS.demo, network };
  if (env.STUDIO_SANDBOX === 'true')
    return { production: false, declared: true, label: LABELS.local, network };
  if (value === 'production')
    return { production: true, declared: true, label: 'Production', network };
  const label = Object.hasOwn(LABELS, value) ? LABELS[value] : undefined;
  if (label) return { production: false, declared: true, label, network };
  return { production: false, declared: false, label: 'Environment not declared', network };
}
