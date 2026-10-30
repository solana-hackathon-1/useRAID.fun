import Link from 'next/link';
import { Discovery } from '@/components/discovery';
import { getRaids } from '@/lib/data';
import { config } from '@/lib/config';
import { guildPublicAvailable } from '@/lib/guild-public-host';
export const dynamic = 'force-dynamic';
export default async function Home() {
  return (
    <>
      {guildPublicAvailable() && (
        <section className="panel guild-entry" aria-label="Guilds">
          <div>
            <h2>Browse Guilds</h2>
            <p className="muted">See the Guilds on RAID and what they have published.</p>
          </div>
          <Link className="button secondary" href="/guilds">
            Browse Guilds
          </Link>
        </section>
      )}
      <Discovery raids={await getRaids()} demo={config.demo} />
    </>
  );
}
