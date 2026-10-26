import { creationHandlers } from '@/lib/work-creation-http';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return creationHandlers.STATE(request);
}
