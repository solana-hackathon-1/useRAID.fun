import { feedHandlers } from '@/lib/work-feed-http';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ listingId: string }> }) {
  return feedHandlers.DETAIL(request, (await context.params).listingId);
}
