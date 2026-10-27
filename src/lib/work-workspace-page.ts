import { cookies } from 'next/headers';
import { currentUser, hash } from './auth';
import { sessionCookie } from './studio-mode';
import {
  readApplicantQueueFromHost,
  readMyRaidsFromHost,
  readReviewQueueFromHost,
  workWorkspaceConfiguration,
} from './work-workspace-host';

async function actor() {
  const user = await currentUser(),
    cookie = (await cookies()).get(sessionCookie())?.value;
  return user && cookie ? { accountId: user.id, sessionHash: hash(cookie) } : null;
}
/** Server-side first paint for the protected work pages; failures never expose detail. */
export async function loadMyRaids() {
  const who = await actor();
  if (!who) return { status: 'SIGN_IN' as const };
  const config = workWorkspaceConfiguration();
  if (!config.readsAvailable) return { status: 'UNAVAILABLE' as const };
  try {
    return {
      status: 'READY' as const,
      view: await readMyRaidsFromHost(who),
      submissionsAvailable: config.submissionsAvailable,
      applicationsAvailable: config.applicationsAvailable,
      startAvailable: config.startsAvailable,
    };
  } catch {
    return { status: 'UNAVAILABLE' as const };
  }
}
export async function loadWorkDesk() {
  const who = await actor();
  if (!who) return { status: 'SIGN_IN' as const };
  const config = workWorkspaceConfiguration();
  if (!config.readsAvailable) return { status: 'UNAVAILABLE' as const };
  try {
    const [reviews, applicants] = await Promise.all([
      readReviewQueueFromHost(who),
      readApplicantQueueFromHost(who),
    ]);
    return {
      status: 'READY' as const,
      reviews,
      applicants,
      reviewsAvailable: config.reviewsAvailable,
      offersAvailable: config.offersAvailable,
    };
  } catch {
    return { status: 'UNAVAILABLE' as const };
  }
}
