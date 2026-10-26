import { workHandlers } from '@/lib/work-workspace-http';
export const dynamic = 'force-dynamic';
export function POST(request: Request, context: { params: Promise<{ applicationId: string }> }) {
  return workHandlers.WITHDRAW(
    request,
    context.params.then((p) => p.applicationId),
  );
}
