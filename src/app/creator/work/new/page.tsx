import Link from 'next/link';
import { WorkWizard } from '@/components/work-wizard';
import { loadCreation } from '@/lib/work-creation-page';

export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Create a Raid',
  robots: { index: false, follow: false },
  description: 'Draft a clear task, review the full reward and publish it.',
};
export default async function CreateRaidPage() {
  const page = await loadCreation();
  return (
    <div className="studio">
      <h1>Create a Raid</h1>
      {page.status === 'SIGN_IN' ? (
        <>
          <p>Sign in to create a Raid.</p>
          <Link className="button" href="/creator/account">
            Sign in
          </Link>
        </>
      ) : page.status === 'UNAVAILABLE' ? (
        <p role="status">Raid creation is currently unavailable. Try again later.</p>
      ) : (
        <WorkWizard initialState={page.state} />
      )}
      <p>
        <Link className="inline-link" href="/creator/work">
          Review and applicants
        </Link>
      </p>
    </div>
  );
}
