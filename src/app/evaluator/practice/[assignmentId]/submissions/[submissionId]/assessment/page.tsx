import { notFound } from 'next/navigation';
import { loadPracticeAssessmentPage } from '@/lib/practice-assessment-page';
import { PracticeAssessmentEditor } from '@/components/practice-assessment-editor';
export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Assessment review',
  description: 'Private assigned assessment review.',
  robots: { index: false, follow: false },
};
export default async function PracticeAssessmentPage({
  params,
}: {
  params: Promise<{ assignmentId: string; submissionId: string }>;
}) {
  const page = await loadPracticeAssessmentPage(await params);
  if (page.status === 'NOT_FOUND') notFound();
  return (
    <div className="studio">
      <h1>Assessment review</h1>
      {page.status === 'READY' ? (
        <PracticeAssessmentEditor key={page.context.review.accessId} context={page.context} />
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
