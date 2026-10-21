import { notFound } from 'next/navigation';
import { loadPracticeOwnershipPage } from '@/lib/practice-ownership-page';
import { PracticeOwnershipEditor } from '@/components/practice-ownership-editor';
export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Ownership review',
  description: 'Private assigned ownership review.',
  robots: { index: false, follow: false },
};
export default async function PracticeOwnershipPage({
  params,
}: {
  params: Promise<{ assignmentId: string; submissionId: string }>;
}) {
  const page = await loadPracticeOwnershipPage(await params);
  if (page.status === 'NOT_FOUND') notFound();
  return (
    <div className="studio">
      <h1>Ownership review</h1>
      {page.status === 'READY' ? (
        <PracticeOwnershipEditor key={page.context.review.accessId} context={page.context} />
      ) : page.status === 'SIGN_IN' ? (
        <>
          <p role="status">Sign in to view this assigned case.</p>
          <a className="button" href="/creator/account">
            Sign in
          </a>
        </>
      ) : (
        <p role="alert">
          {page.status === 'RATE_LIMITED'
            ? 'Too many requests. Wait before rechecking.'
            : 'This case is currently unavailable for your account. Recheck access later.'}
        </p>
      )}
    </div>
  );
}
