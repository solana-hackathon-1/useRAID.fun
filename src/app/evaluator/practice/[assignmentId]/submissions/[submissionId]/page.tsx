import { notFound } from 'next/navigation';
import { PracticeReviewCase } from '@/components/practice-review-case';
import { loadPracticeReviewPage } from '@/lib/practice-review-page';
export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Practice review',
  description: 'Private evidence for an explicitly assigned practice review.',
  robots: { index: false, follow: false },
};
export default async function PracticeReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ assignmentId: string; submissionId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [path, query] = await Promise.all([params, searchParams]);
  const page = await loadPracticeReviewPage(path, query);
  if (page.status === 'NOT_FOUND') notFound();
  const scope = page.scope;
  return (
    <div className="studio">
      <h1>Practice review</h1>
      {page.status === 'READY' ? (
        <>
          <PracticeReviewCase review={page.review} />
          {scope.purpose === 'ASSESSMENT_REVIEW' && (
            <a
              className="button"
              href={
                '/evaluator/practice/' +
                encodeURIComponent(scope.assignmentId) +
                '/submissions/' +
                encodeURIComponent(scope.submissionId) +
                '/assessment'
              }
            >
              Review assessment
            </a>
          )}
          {scope.purpose === 'OWNERSHIP_REVIEW' && (
            <a
              className="button"
              href={
                '/evaluator/practice/' +
                encodeURIComponent(scope.assignmentId) +
                '/submissions/' +
                encodeURIComponent(scope.submissionId) +
                '/ownership'
              }
            >
              Review ownership finding
            </a>
          )}
        </>
      ) : page.status === 'SIGN_IN' ? (
        <>
          <p role="status">Sign in to view this assigned case.</p>
          <a className="button" href="/creator/account">
            Sign in
          </a>
        </>
      ) : page.status === 'DENIED' ? (
        <p role="alert">This case is unavailable for your account.</p>
      ) : page.status === 'RATE_LIMITED' ? (
        <p role="alert">Too many requests. Wait a moment before rechecking access.</p>
      ) : (
        <p role="status">This case is currently unavailable. Try again later.</p>
      )}
      <form
        method="get"
        action={
          '/evaluator/practice/' +
          encodeURIComponent(scope.assignmentId) +
          '/submissions/' +
          encodeURIComponent(scope.submissionId)
        }
      >
        <input type="hidden" name="purpose" value={scope.purpose} />
        <button className="button secondary" type="submit">
          Recheck access
        </button>
      </form>
    </div>
  );
}
