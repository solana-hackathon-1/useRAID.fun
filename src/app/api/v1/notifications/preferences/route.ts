import { notificationHandlers } from '@/lib/notifications-http';
export const dynamic = 'force-dynamic';
export function POST(request: Request) {
  return notificationHandlers.PREFERENCES(request);
}
