import { creationHandlers } from '@/lib/work-creation-http';
export const dynamic = 'force-dynamic';
export function POST(request: Request) {
  return creationHandlers.RECOMMEND(request);
}
