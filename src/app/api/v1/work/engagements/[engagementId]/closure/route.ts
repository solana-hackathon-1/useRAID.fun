import { closureHandlers } from '@/lib/work-closure-http';
export const dynamic = 'force-dynamic';
export function POST(request: Request, context: { params: Promise<{ engagementId: string }> }) {
  return closureHandlers.CLOSE(
    request,
    context.params.then((p) => p.engagementId),
  );
}
