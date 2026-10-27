import Link from 'next/link';
import { MyRaidsWorkspace } from '@/components/work-workspace';
import { loadMyRaids } from '@/lib/work-workspace-page';

export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'My Raid',
  robots: { index: false, follow: false },
  description: 'Your accepted Raids, submissions, review feedback, applications and offers.',
};
export default async function MyRaidPage() {
  const page = await loadMyRaids();
  return (
    <div className="studio">
      <h1>My Raid</h1>
      {page.status === 'SIGN_IN' ? (
        <>
          <p>Sign in to see your Raids.</p>
          <Link className="button" href="/creator/account">
            Sign in
          </Link>
        </>
      ) : page.status === 'UNAVAILABLE' ? (
        <p role="status">Your Raid workspace is currently unavailable. Try again later.</p>
      ) : (
        <MyRaidsWorkspace
          initial={page.view}
          submissionsAvailable={page.submissionsAvailable}
          applicationsAvailable={page.applicationsAvailable}
          startAvailable={page.startAvailable}
        />
      )}
      <p>
        <Link className="inline-link" href="/creator/work">
          Review and applicant desk
        </Link>
      </p>
    </div>
  );
}
