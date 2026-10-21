import { practiceOwnershipHandlers } from '@/lib/practice-ownership-http';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
type Context = { params: Promise<{ assignmentId: string; submissionId: string }> };
export function GET(request: Request, context: Context) {
  return practiceOwnershipHandlers.GET(request, context.params);
}
export function POST(request: Request, context: Context) {
  return practiceOwnershipHandlers.POST(request, context.params);
}
