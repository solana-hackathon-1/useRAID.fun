import { cookies } from 'next/headers';
import { z } from 'zod';
import { currentUser, hash } from './auth';
import { sessionCookie } from './studio-mode';
import {
  listPracticeTrialsFromHost,
  readPracticeProgressFromHost,
  practicePortalReadConfiguration,
  practiceStartConfiguration,
  practiceSubmitConfiguration,
} from './practice-portal-host';

async function actor() {
  const user = await currentUser(),
    cookie = (await cookies()).get(sessionCookie())?.value;
  return user && cookie ? { accountId: user.id, sessionHash: hash(cookie) } : null;
}
/** Server-side first paint for the protected practice pages; failures never expose detail. */
export async function loadPracticeCatalog() {
  const who = await actor();
  if (!who) return { status: 'SIGN_IN' as const };
  if (!practicePortalReadConfiguration().readsAvailable) return { status: 'UNAVAILABLE' as const };
  try {
    const catalog = await listPracticeTrialsFromHost(who, null);
    return {
      status: 'READY' as const,
      catalog,
      writesAvailable: practiceStartConfiguration().writesAvailable,
    };
  } catch {
    return { status: 'UNAVAILABLE' as const };
  }
}
export async function loadPracticeWorkspace(startId: string) {
  if (!z.uuid().safeParse(startId).success) return { status: 'NOT_FOUND' as const };
  const who = await actor();
  if (!who) return { status: 'SIGN_IN' as const };
  if (!practicePortalReadConfiguration().readsAvailable) return { status: 'UNAVAILABLE' as const };
  try {
    const progress = await readPracticeProgressFromHost(who, startId);
    if (progress === null || progress === undefined) return { status: 'NOT_FOUND' as const };
    return {
      status: 'READY' as const,
      progress,
      writesAvailable: practiceSubmitConfiguration().writesAvailable,
    };
  } catch {
    return { status: 'UNAVAILABLE' as const };
  }
}
