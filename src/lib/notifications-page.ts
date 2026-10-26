import { cookies } from 'next/headers';
import { currentUser, hash } from './auth';
import { sessionCookie } from './studio-mode';
import { notificationStateFromHost, notificationsConfiguration } from './notifications-host';

/** Server-side first paint for the notifications page; failures never expose detail. */
export async function loadNotifications() {
  const user = await currentUser(),
    cookie = (await cookies()).get(sessionCookie())?.value;
  if (!user || !cookie) return { status: 'SIGN_IN' as const };
  if (!notificationsConfiguration().readsAvailable) return { status: 'UNAVAILABLE' as const };
  try {
    return {
      status: 'READY' as const,
      state: await notificationStateFromHost({ accountId: user.id, sessionHash: hash(cookie) }),
    };
  } catch {
    return { status: 'UNAVAILABLE' as const };
  }
}
