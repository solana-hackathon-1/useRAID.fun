import { workHandlers } from '@/lib/work-workspace-http';
export const dynamic = 'force-dynamic';
export function POST(request: Request, context: { params: Promise<{ engagementId: string }> }) {
  return workHandlers.START(
    request,
    context.params.then((p) => p.engagementId),
  );
}
