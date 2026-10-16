import { practicePortalHandlers } from '@/lib/practice-portal-http';
export const dynamic = 'force-dynamic';
export function POST(request: Request) {
  return practicePortalHandlers.START(request);
}
