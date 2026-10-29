import { z } from 'zod';
import { WorkError } from '../work-loop/contracts';
import {
  FeedQuerySchema,
  type Detail,
  type FeedPage,
  type FeedQuery,
} from '../work-loop/feed-contracts';
import { cookies } from 'next/headers';
import { currentUser, hash } from './auth';
import { sessionCookie } from './studio-mode';
import { readMyRaidsFromHost, workWorkspaceConfiguration } from './work-workspace-host';
import { readDetailFromHost, readFeedFromHost, workFeedAvailable } from './work-feed-host';

type Params = Record<string, string | string[] | undefined>;
export type LoadedFeed =
  | { status: 'UNAVAILABLE' }
  | { status: 'INVALID'; query: Partial<FeedQuery> }
  | { status: 'READY'; page: FeedPage; query: FeedQuery };
/** Server-side first paint of the public feed. Failures never expose detail. */
export async function loadFeed(params: Params): Promise<LoadedFeed> {
  if (!workFeedAvailable()) return { status: 'UNAVAILABLE' };
  const raw: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    // A repeated parameter is refused, never silently reduced to one of its values.
    if (Array.isArray(value)) return { status: 'INVALID', query: {} };
    raw[name] =
      name === 'limit' && /^\d{1,3}$/.test(value)
        ? Number(value)
        : name === 'closesBefore' && /^\d{4}-\d{2}-\d{2}$/.test(value)
          ? `${value}T00:00:00.000Z`
          : value;
  }
  const query = FeedQuerySchema.safeParse(raw);
  if (!query.success) return { status: 'INVALID', query: {} };
  try {
    return { status: 'READY', page: await readFeedFromHost(query.data), query: query.data };
  } catch {
    return { status: 'UNAVAILABLE' };
  }
}
export type LoadedDetail =
  { status: 'UNAVAILABLE' } | { status: 'NOT_FOUND' } | { status: 'READY'; detail: Detail };
/** Server-side first paint of one public brief. A malformed or unlisted id is one answer. */
export async function loadDetail(listingId: string): Promise<LoadedDetail> {
  if (!workFeedAvailable()) return { status: 'UNAVAILABLE' };
  if (!z.uuid().safeParse(listingId).success) return { status: 'NOT_FOUND' };
  try {
    return { status: 'READY', detail: await readDetailFromHost(listingId) };
  } catch (error) {
    return error instanceof WorkError && error.code === 'NOT_FOUND'
      ? { status: 'NOT_FOUND' }
      : { status: 'UNAVAILABLE' };
  }
}
export type ApplyState = 'FORM' | 'ACCEPT' | 'SIGN_IN' | 'CLOSED' | 'NOT_APPLICABLE';
async function signedIn() {
  try {
    return (await currentUser()) !== null;
  } catch {
    return false;
  }
}
/**
 * What the brief offers this viewer. Informational only: the command itself rechecks the session, flags, quota,
 * eligibility and source at the moment of the action. Application Raids are applied to; instant-start Raids are
 * accepted directly.
 */
export async function applyMode(detail: Pick<Detail, 'admission'>): Promise<ApplyState> {
  if (!(await signedIn())) return 'SIGN_IN';
  const config = workWorkspaceConfiguration();
  if (detail.admission === 'APPLICATION')
    return config.readsAvailable && config.applicationsAvailable ? 'FORM' : 'CLOSED';
  return config.readsAvailable && config.acceptanceAvailable ? 'ACCEPT' : 'CLOSED';
}
/**
 * The viewer's own usable offer for the terms and an open slot shown on this brief, if any. Read only for a signed-in
 * person while acceptance is open; any failure reads as no offer. The server rechecks the offer's state, expiry and
 * issuer when the person accepts.
 */
export async function pendingOffer(
  detail: Pick<Detail, 'termsVersionId' | 'openSlotIds'>,
): Promise<{ offerId: string; slotId: string } | null> {
  try {
    const config = workWorkspaceConfiguration();
    if (!config.readsAvailable || !config.acceptanceAvailable) return null;
    const user = await currentUser(),
      cookie = (await cookies()).get(sessionCookie())?.value;
    if (!user || !cookie) return null;
    const mine = await readMyRaidsFromHost({ accountId: user.id, sessionHash: hash(cookie) });
    for (const a of mine.applications)
      if (
        a.state === 'SUBMITTED' &&
        a.termsVersionId === detail.termsVersionId &&
        detail.openSlotIds.includes(a.slotId) &&
        a.offer?.state === 'PENDING' &&
        !a.offer.expired
      )
        return { offerId: a.offer.offerId, slotId: a.slotId };
    return null;
  } catch {
    return null;
  }
}
