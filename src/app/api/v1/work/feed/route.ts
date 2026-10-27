import { feedHandlers } from '@/lib/work-feed-http';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return feedHandlers.GET(request);
}
