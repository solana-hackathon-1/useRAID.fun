import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PracticeTrialWorkspace } from '@/components/practice-trial-portal';
import { loadPracticeWorkspace } from '@/lib/practice-portal-page';
export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Practice attempt',
  robots: { index: false, follow: false },
  description: 'Your private practice attempt. Practice does not verify a rank.',
};
export default async function PracticeAttemptPage({
  params,
}: {
  params: Promise<{ startId: string }>;
}) {
  const { startId } = await params,
    page = await loadPracticeWorkspace(startId);
  if (page.status === 'NOT_FOUND') notFound();
  return (
    <div className="studio">
      <h1>Practice attempt</h1>
      {page.status === 'SIGN_IN' ? (
        <>
          <p>Sign in to view this attempt.</p>
          <Link className="button" href="/creator/account">
            Sign in
          </Link>
        </>
      ) : page.status === 'UNAVAILABLE' ? (
        <p role="status">This practice attempt is currently unavailable. Try again later.</p>
      ) : (
        <PracticeTrialWorkspace initial={page.progress} writesAvailable={page.writesAvailable} />
      )}
      <p>
        <Link className="inline-link" href="/raider/practice">
          All practice trials
        </Link>
      </p>
    </div>
  );
}
