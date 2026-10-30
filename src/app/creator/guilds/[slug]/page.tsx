import Link from 'next/link';
import { z } from 'zod';
import { GuildProfileEditor, GuildUpdatesManager } from '@/components/guild-manage';
import { GuildAuthorityLabels } from '@/components/guild-manage-labels';
import { ManagedGuildUpdateSchema } from '@/guild-profiles/guild-storage-contracts';
import { loadManagedGuilds } from '@/lib/guild-manage-page';
import { listUpdatesState } from '@/lib/guild-updates-host';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Manage Guild', robots: { index: false, follow: false } };
const UpdatesStateSchema = z.object({
  updates: z.array(ManagedGuildUpdateSchema).max(100),
  writesAvailable: z.boolean(),
});
const Back = () => (
  <Link className="studio-back" href="/creator/guilds">
    ← My Guilds
  </Link>
);
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const state = await loadManagedGuilds();
  if (state.kind === 'SIGNED_OUT')
    return (
      <div className="studio">
        <h1>Manage Guild</h1>
        <p>Sign in to manage your Guild.</p>
        <Link className="button" href="/creator/account">
          Sign in
        </Link>
      </div>
    );
  if (state.kind === 'FAILED')
    return (
      <div className="studio">
        <Back />
        <h1>Manage Guild</h1>
        <p role="alert">This Guild could not be loaded. Refresh or sign in again.</p>
      </div>
    );
  const entry = state.guilds.find((g) => g.guild.slug === slug);
  // One answer for a Guild that does not exist and one the caller holds nothing in: no existence oracle.
  if (!entry)
    return (
      <div className="studio">
        <Back />
        <h1>Manage Guild</h1>
        <p>This Guild was not found or you do not manage it.</p>
      </div>
    );
  const { guild, authority } = entry;
  const profile = authority.kinds.includes('PROFILE');
  let updates: z.infer<typeof UpdatesStateSchema> | null = null;
  if (profile) {
    try {
      const parsed = UpdatesStateSchema.safeParse(await listUpdatesState(state.actor, guild.id));
      if (parsed.success) updates = parsed.data;
    } catch {}
  }
  return (
    <div className="studio">
      <Back />
      <header className="studio-heading">
        <div>
          <h1>{guild.name}</h1>
          <GuildAuthorityLabels founder={authority.founder} kinds={authority.kinds} />
        </div>
      </header>
      <div className="orientation-layout">
        {profile ? (
          <>
            <GuildProfileEditor guild={guild} writesAvailable={state.profileWritesAvailable} />
            {updates ? (
              <GuildUpdatesManager
                guildId={guild.id}
                updates={updates.updates}
                founder={authority.founder}
                writesAvailable={updates.writesAvailable}
              />
            ) : (
              <section className="orientation-card">
                <h2>Public updates</h2>
                <p role="alert">Updates could not be loaded. Refresh to try again.</p>
              </section>
            )}
          </>
        ) : (
          <section className="orientation-card">
            <h2>{guild.name}</h2>
            <p>{guild.description}</p>
            <p>
              Profile and update management need profile authority, which you do not hold in this
              Guild.
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
