import { notificationHandlers } from '@/lib/notifications-http';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return notificationHandlers.STATE(request);
}
