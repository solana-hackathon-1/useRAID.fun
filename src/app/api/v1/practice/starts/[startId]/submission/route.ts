import { practicePortalHandlers } from '@/lib/practice-portal-http';
export const dynamic = 'force-dynamic';
export function POST(request: Request, context: { params: Promise<{ startId: string }> }) {
  return practicePortalHandlers.SUBMIT(
    request,
    context.params.then((p) => p.startId),
  );
}
