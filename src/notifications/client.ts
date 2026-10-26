import { z } from 'zod';
import { WorkClientError, fetchTransport, type WorkTransport } from '../work-http/workspace-client';
import { NotificationStateSchema, PreferencesSchema } from './contracts';

const Envelope = z.object({
  error: z.object({ code: z.string(), requestId: z.string().optional() }),
});
const Read = z.strictObject({ id: z.uuid(), read: z.literal(true) });
/** Portable browser view of the notification boundary: strict response parsing, safe errors only. */
export function createNotificationClient(transport: WorkTransport = fetchTransport) {
  async function call<T>(
    schema: z.ZodType<T>,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ) {
    const { status, body: payload } = await transport.request(
      method,
      path,
      body === undefined ? undefined : { body },
    );
    if (status >= 200 && status < 300) {
      const parsed = schema.safeParse(payload);
      if (!parsed.success) throw new WorkClientError('CONTRACT', status);
      return parsed.data;
    }
    const envelope = Envelope.safeParse(payload);
    throw envelope.success
      ? new WorkClientError(envelope.data.error.code, status, envelope.data.error.requestId ?? null)
      : new WorkClientError('CONTRACT', status);
  }
  return {
    state: () => call(NotificationStateSchema, 'GET', '/api/v1/notifications'),
    markRead: (id: string) =>
      call(Read, 'POST', `/api/v1/notifications/${encodeURIComponent(id)}/read`, {}),
    setPreferences: (promotional: boolean) =>
      call(PreferencesSchema, 'POST', '/api/v1/notifications/preferences', { promotional }),
  };
}
export type NotificationClient = ReturnType<typeof createNotificationClient>;
