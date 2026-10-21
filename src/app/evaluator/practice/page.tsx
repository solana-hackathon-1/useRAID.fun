import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { practiceReviewInboxHandlers } from '../../../lib/practice-review-inbox';
import { createPracticeReviewInboxLoader } from '../../../skills/practice-review-inbox-page';
import { PracticeReviewInbox } from '../../../components/practice-review-inbox';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const metadata: Metadata = {
  title: 'Practice assignments',
  robots: { index: false, follow: false },
};
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const state = await createPracticeReviewInboxLoader(practiceReviewInboxHandlers.GET)(
    await searchParams,
  );
  if (state.status === 'NOT_FOUND') notFound();
  return <PracticeReviewInbox state={state} />;
}
