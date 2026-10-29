import Link from 'next/link';
import { XConnection } from './x-connection';
import { config } from '@/lib/config';
export function StudioAccess({ auth, returnTo }: { auth?: string; returnTo?: string }) {
  return (
    <div className="studio studio-access">
      <h1>Bring your community to a post.</h1>
      <p>
        Connect X, choose your target posts, and fund a Raid. Your community earns from verified
        contributions.
      </p>
      <XConnection status={auth} demo={config.demo} returnTo={returnTo} />
      <Link className="inline-link" href="/">
        Explore Raids
      </Link>
    </div>
  );
}
