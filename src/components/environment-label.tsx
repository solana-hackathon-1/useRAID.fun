/**
 * The persistent non-production label (blueprint §30.1). One presentational component shared by the page shell and
 * the root error page, so the markup cannot drift. It has no control of any kind: it cannot be dismissed.
 */
export type EnvironmentLabelValue = {
  label: string;
  declared: boolean;
  /** The §30.1 network indicator; absent (for example from an unexpected reply) shows no network, never a guess. */
  network?: 'devnet' | 'mainnet' | 'unconfigured';
};

const NETWORK_TEXT = {
  devnet: 'Devnet',
  mainnet: 'Mainnet',
  unconfigured: 'Network not configured',
};

export function EnvironmentLabel({ environment }: { environment: EnvironmentLabelValue }) {
  return (
    <div className="env-label">
      <span className="env-label-name">{environment.label}</span>
      {environment.network && (
        <span className="env-label-network">{NETWORK_TEXT[environment.network]}</span>
      )}
      <span className="env-label-detail">
        {environment.declared ? 'Not production' : 'Treat as not production'}
      </span>
    </div>
  );
}
