import Link from 'next/link';
import { launchRouteState } from '@/lib/launch-route-state';
import { launchpadsAvailable } from '@/lib/release';
export const dynamic = 'force-dynamic';
export default async function LaunchPage() {
  if (!launchpadsAvailable)
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
  // DEC-2026-11-07-04: the launch route is a state, never a form, until O02 and O08 are decided.
  const route = launchRouteState();
  return (
    <section className="panel access-card">
      <span className="status-pill">Not configured</span>
      <h1>Launch a token</h1>
      <p>
        Token launch is not configured yet. It waits on owner decisions{' '}
        {route.openDecisions.join(' and ')} (launch supply, allocation, curve and fees). No values
        are assumed, and nothing can be started until they are decided.
      </p>
      <p>Create Raids for existing projects, join campaigns, and track verified X contributions.</p>
      <Link className="button" href="/creator">
        Create a Raid
      </Link>
    </section>
  );
}
