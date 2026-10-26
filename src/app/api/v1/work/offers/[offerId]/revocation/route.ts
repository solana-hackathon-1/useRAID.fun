import { workHandlers } from '@/lib/work-workspace-http';
export const dynamic = 'force-dynamic';
export function POST(request: Request, context: { params: Promise<{ offerId: string }> }) {
  return workHandlers.REVOKE_OFFER(
    request,
    context.params.then((p) => p.offerId),
  );
}
