import { requireUser } from '@/lib/auth';
import { failure } from '@/lib/http';
import { notificationsConfiguration } from '@/lib/notifications-host';
import { workerHealthSnapshot } from '@/lib/worker-health';
export const dynamic = 'force-dynamic';
/** Read-only operations signal: counts, ages and step names. Administrator only; never exposes payloads or errors. */
export async function GET() {
  try {
    await requireUser(true);
    return Response.json(
      await workerHealthSnapshot(new Date(), {
        outboxDispatchEnabled: notificationsConfiguration().dispatchAvailable,
      }),
    );
  } catch (error) {
    return failure(error);
  }
}
