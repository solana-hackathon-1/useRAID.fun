import { creationHandlers } from '@/lib/work-creation-http';
export const dynamic = 'force-dynamic';
export function POST(request: Request, context: { params: Promise<{ listingId: string }> }) {
  return creationHandlers.PUBLISH(
    request,
    context.params.then((p) => p.listingId),
  );
}
