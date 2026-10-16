import { practicePortalHandlers } from '@/lib/practice-portal-http';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return practicePortalHandlers.LIST(request);
}
