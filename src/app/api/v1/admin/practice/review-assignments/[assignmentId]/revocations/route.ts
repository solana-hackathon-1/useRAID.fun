import { practiceReviewAssignmentHandlers } from '../../../../../../../../lib/practice-review-assignment-http';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function POST(
  request: Request,
  context: { params: Promise<{ assignmentId: string }> },
) {
  return practiceReviewAssignmentHandlers.revoke(request, context.params);
}
