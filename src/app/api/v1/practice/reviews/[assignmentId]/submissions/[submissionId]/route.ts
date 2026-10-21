import { practiceReviewHandlers } from '@/lib/practice-review-http';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export function GET(
  request: Request,
  context: { params: Promise<{ assignmentId: string; submissionId: string }> },
) {
  return practiceReviewHandlers.GET(request, context.params);
}
