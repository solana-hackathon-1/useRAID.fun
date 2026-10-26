import { cookies } from 'next/headers';
import { randomUUID } from 'node:crypto';
import { requireUser, checkOrigin, rateLimit, hash, HttpError } from './auth';
import { sessionCookie } from './studio-mode';
import { WorkHttpError } from '../work-http/workspace-http';
import { createNotificationHandlers } from '../notifications/http';
import {
  markReadFromHost,
  notificationStateFromHost,
  setPreferencesFromHost,
} from './notifications-host';

async function authority<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof HttpError && [401, 403, 429].includes(e.status))
      throw new WorkHttpError(e.status as 401 | 403 | 429);
    throw e;
  }
}
export const notificationHandlers = createNotificationHandlers({
  version: 'v1',
  requestId: randomUUID,
  actor: () =>
    authority(async () => {
      const u = await requireUser(),
        cookie = (await cookies()).get(sessionCookie())?.value;
      if (!cookie) throw new WorkHttpError(401);
      return { accountId: u.id, sessionHash: hash(cookie) };
    }),
  checkOrigin: (r) => authority(() => checkOrigin(r)),
  rateLimit: (a) => authority(() => rateLimit('notifications:' + a.accountId, 120, 60)),
  state: notificationStateFromHost,
  markRead: markReadFromHost,
  setPreferences: setPreferencesFromHost,
});
