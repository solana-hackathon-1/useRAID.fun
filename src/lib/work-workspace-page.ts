import { cookies } from 'next/headers';
import { currentUser, hash } from './auth';
import { sessionCookie } from './studio-mode';
import {
  readActiveRaidFromHost,
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
/**
 * Site-wide My Raid indicator: the held Raid for the current session, or null. Closed flag, no session, nothing held
 * and any failure all render nothing, so the header never breaks or leaks why. Rendered per request (private, no-store).
 */
export async function loadActiveRaid(): Promise<{ engagementId: string; title: string } | null> {
  if (!workWorkspaceConfiguration().readsAvailable) return null;
  try {
    const who = await actor();
    const held = who ? await readActiveRaidFromHost(who) : null;
    return held ? { engagementId: held.engagementId, title: held.title } : null;
  } catch {
    return null;
  }
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
