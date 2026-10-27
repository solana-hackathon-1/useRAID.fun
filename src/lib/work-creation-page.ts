import { cookies } from 'next/headers';
import { currentUser, hash } from './auth';
import { sessionCookie } from './studio-mode';
import { creationStateFromHost, workCreationConfiguration } from './work-creation-host';

/** Server-side first paint for the Founder wizard; failures never expose detail. */
export async function loadCreation() {
  const user = await currentUser(),
    cookie = (await cookies()).get(sessionCookie())?.value;
  if (!user || !cookie) return { status: 'SIGN_IN' as const };
  if (!workCreationConfiguration().readsAvailable) return { status: 'UNAVAILABLE' as const };
  try {
    return {
      status: 'READY' as const,
      accountId: user.id,
      state: await creationStateFromHost({ accountId: user.id, sessionHash: hash(cookie) }),
    };
  } catch {
    return { status: 'UNAVAILABLE' as const };
  }
}
