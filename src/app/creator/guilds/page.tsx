import Link from 'next/link';
import { GuildAuthorityLabels } from '@/components/guild-manage-labels';
import { loadManagedGuilds } from '@/lib/guild-manage-page';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'My Guilds', robots: { index: false, follow: false } };
export default async function Page() {
  const state = await loadManagedGuilds();
  if (state.kind === 'SIGNED_OUT')
    return (
      <div className="studio">
        <h1>My Guilds</h1>
        <p>Sign in to see the Guilds you manage.</p>
        <Link className="button" href="/creator/account">
          Sign in
        </Link>
      </div>
    );
  if (state.kind === 'FAILED')
    return (
      <div className="studio">
        <h1>My Guilds</h1>
        <p role="alert">Your Guilds could not be loaded. Refresh or sign in again.</p>
        <Link className="inline-link" href="/creator/guilds">
          Try again
        </Link>
      </div>
    );
  return (
    <div className="studio">
      <Link className="studio-back" href="/creator/account">
        ← Account
      </Link>
      <header className="studio-heading">
        <div>
          <h1>My Guilds</h1>
          <p>Guilds where you are the Founder or hold a role.</p>
        </div>
      </header>
      <div className="orientation-layout">
        {state.guilds.length === 0 ? (
          <p>You do not manage any Guilds yet.</p>
        ) : (
          state.guilds.map(({ guild, authority }) => (
            <section className="orientation-card" key={guild.slug}>
              <h2>
                <Link className="inline-link" href={'/creator/guilds/' + guild.slug}>
                  {guild.name}
                </Link>
              </h2>
              <p>{guild.description}</p>
              <GuildAuthorityLabels founder={authority.founder} kinds={authority.kinds} />
            </section>
          ))
        )}
      </div>
    </div>
  );
}
