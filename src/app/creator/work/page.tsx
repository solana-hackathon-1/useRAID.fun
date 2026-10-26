import Link from 'next/link';
import { WorkDesk } from '@/components/work-workspace';
import { loadWorkDesk } from '@/lib/work-workspace-page';

export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Review and applicants',
  robots: { index: false, follow: false },
  description: 'Submissions waiting for your review and applicants on listings you manage.',
};
export default async function WorkDeskPage() {
  const page = await loadWorkDesk();
  return (
    <div className="studio">
      <h1>Review and applicants</h1>
      {page.status === 'SIGN_IN' ? (
        <>
          <p>Sign in to see your review and applicant desk.</p>
          <Link className="button" href="/creator/account">
            Sign in
          </Link>
        </>
      ) : page.status === 'UNAVAILABLE' ? (
        <p role="status">
          The review and applicant desk is currently unavailable. Try again later.
        </p>
      ) : (
        <WorkDesk
          initialReviews={page.reviews}
          initialApplicants={page.applicants}
          reviewsAvailable={page.reviewsAvailable}
          offersAvailable={page.offersAvailable}
        />
      )}
      <p>
        <Link className="inline-link" href="/raider/work">
          My Raid
        </Link>
      </p>
    </div>
  );
}
