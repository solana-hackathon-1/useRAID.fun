const LABEL: Record<string, string> = {
  PROFILE: 'Profile',
  WORK: 'Work',
  TREASURY: 'Treasury',
  DISPUTE: 'Dispute',
};
/** Exactly the authority the caller holds, as text (never colour alone). Treasury and dispute stay separate roles. */
export function GuildAuthorityLabels({ founder, kinds }: { founder: boolean; kinds: string[] }) {
  return (
    <p className="orientation-hint">
      Your authority:{' '}
      {[...(founder ? ['Founder'] : []), ...kinds.map((k) => LABEL[k] ?? k)].join(', ')}
    </p>
  );
}
