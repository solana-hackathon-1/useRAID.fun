/**
 * The persistent non-production label (blueprint §30.1). One presentational component shared by the page shell and
 * the root error page, so the markup cannot drift. It has no control of any kind: it cannot be dismissed.
 */
export type EnvironmentLabelValue = { label: string; declared: boolean };

export function EnvironmentLabel({ environment }: { environment: EnvironmentLabelValue }) {
  return (
    <div className="env-label">
      <span className="env-label-name">{environment.label}</span>
      <span className="env-label-detail">
        {environment.declared ? 'Not production' : 'Treat as not production'}
      </span>
    </div>
  );
}
