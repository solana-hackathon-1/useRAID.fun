import Link from 'next/link';
import { cookies } from 'next/headers';
import { currentUser, hash } from '@/lib/auth';
import { sessionCookie } from '@/lib/studio-mode';
import { readOrientationState } from '@/lib/raider-onboarding-host';
import type { OrientationState } from '@/raider-onboarding/host-contracts';
import { RaiderOrientationForm } from '@/components/raider-orientation-form';
export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Raider orientation',
  description: 'Learn work commitments and set private work preferences.',
};
export default async function OnboardingPage() {
  const user = await currentUser();
  const cookie = (await cookies()).get(sessionCookie())?.value;
  if (!user || !cookie)
    return (
      <div className="studio">
        <h1>Raider orientation</h1>
        <p>Sign in to read your saved preferences and set your work interests.</p>
        <Link className="button" href="/creator/account">
          Sign in
        </Link>
      </div>
    );
  let state: OrientationState | undefined;
  try {
    state = await readOrientationState({
      accountId: user.id,
      actorAccountId: user.id,
      sessionHash: hash(cookie),
    });
  } catch {
    /* The fixed unavailable state reveals no private driver detail. */
  }
  if (!state)
    return (
      <div className="studio">
        <h1>Raider orientation</h1>
        <p role="alert">
          Saved preferences could not be loaded. Refresh or sign in again to continue.
        </p>
        <Link className="inline-link" href="/creator/account">
          Account
        </Link>
      </div>
    );
  return (
    <div className="studio">
      <header className="studio-heading">
        <div>
          <h1>Raider orientation</h1>
          <p>Learn the commitments and choose the work you want to explore.</p>
        </div>
      </header>
      <RaiderOrientationForm
        state={state}
        browseLink={
          <Link className="inline-link" href="/">
            Browse current campaigns
          </Link>
        }
      />
    </div>
  );
}
