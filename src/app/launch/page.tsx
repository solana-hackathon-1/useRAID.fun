import Link from 'next/link';
import { currentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { meteoraLaunchSwitch, meteoraReadiness } from '@/lib/meteora/config';
import { MeteoraLaunchWizard } from '@/components/meteora-launch-wizard';
import { launchpadsAvailable } from '@/lib/release';
export const dynamic = 'force-dynamic';
export default async function LaunchPage() {
  // Both launch products are off by default: the Pump gate stays closed and Meteora has its own switch.
  if (!launchpadsAvailable && !meteoraLaunchSwitch())
    return (
      <section className="panel access-card">
        <span className="status-pill">Coming soon</span>
        <h1>Launchpads</h1>
        <p>
          Token creation, creator-fee collection, trading, and automated reward payouts are coming
          soon.
        </p>
        <p>
          Create Raids for existing projects, join campaigns, and track verified X contributions.
        </p>
        <Link className="button" href="/creator">
          Create a Raid
        </Link>
      </section>
    );
  const user = await currentUser();
  const readiness = meteoraReadiness();
  const wallet = user ? await db.walletIdentity.findUnique({ where: { userId: user.id } }) : null;
  const recoveries = user
    ? await db.tokenLaunch.findMany({
        where: {
          userId: user.id,
          provider: 'METEORA',
          network: readiness.network,
          status: { in: ['PREPARED', 'SUBMITTED', 'LIVE', 'PAUSED'] },
        },
        select: { id: true, name: true, symbol: true, status: true, mint: true },
        orderBy: { createdAt: 'desc' },
        take: 20,
      })
    : [];
  return (
    <MeteoraLaunchWizard
      readiness={readiness}
      walletAddress={wallet?.address || null}
      signedIn={!!user}
      recoveries={recoveries}
    />
  );
}
