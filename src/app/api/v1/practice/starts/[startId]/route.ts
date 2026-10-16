import { practicePortalHandlers } from '@/lib/practice-portal-http';
export const dynamic = 'force-dynamic';
export function GET(request: Request, context: { params: Promise<{ startId: string }> }) {
  return practicePortalHandlers.READ(
    request,
    context.params.then((p) => p.startId),
  );
}
