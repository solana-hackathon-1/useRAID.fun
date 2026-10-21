import { practiceAssessmentHandlers } from '@/lib/practice-assessment-http';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
type Context = { params: Promise<{ assignmentId: string; submissionId: string }> };
export function GET(request: Request, context: Context) {
  return practiceAssessmentHandlers.state.GET(request, context.params);
}
