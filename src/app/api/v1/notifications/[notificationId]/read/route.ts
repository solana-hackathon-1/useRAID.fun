import { notificationHandlers } from '@/lib/notifications-http';
export const dynamic = 'force-dynamic';
export function POST(request: Request, context: { params: Promise<{ notificationId: string }> }) {
  return notificationHandlers.READ(
    request,
    context.params.then((p) => p.notificationId),
  );
}
