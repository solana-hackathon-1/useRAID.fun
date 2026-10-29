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
import type { ApplyMode } from './work-apply-mode';
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
export type ApplyState = ApplyMode;
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
export interface ViewerStanding {
  /** The viewer's own usable offer for these terms and an open slot; set only while acceptance is open. */
  offer: { offerId: string; slotId: string } | null;
  /** The viewer already has a submitted application for these terms. */
  applied: boolean;
  /** The open slot to apply to: a stable per-person choice, so applicants do not all contend on one slot. */
  applySlotId: string;
}
/**
 * What the signed-in viewer already holds on this brief. Any failure reads as nothing held and the first open slot;
 * the server rechecks every state, expiry and issuer when the person acts.
 */
export async function viewerStanding(
  detail: Pick<Detail, 'termsVersionId' | 'openSlotIds'>,
): Promise<ViewerStanding> {
  const none: ViewerStanding = { offer: null, applied: false, applySlotId: detail.openSlotIds[0] };
  try {
    const config = workWorkspaceConfiguration();
    if (!config.readsAvailable) return none;
    const user = await currentUser(),
      cookie = (await cookies()).get(sessionCookie())?.value;
    if (!user || !cookie) return none;
    const mine = await readMyRaidsFromHost({ accountId: user.id, sessionHash: hash(cookie) });
    const slots = detail.openSlotIds;
    const standing: ViewerStanding = {
      ...none,
      applySlotId: slots[parseInt(hash(user.id).slice(0, 8), 16) % slots.length],
    };
    for (const a of mine.applications) {
      if (a.state !== 'SUBMITTED' || a.termsVersionId !== detail.termsVersionId) continue;
      standing.applied = true;
      if (
        config.acceptanceAvailable &&
        !standing.offer &&
        slots.includes(a.slotId) &&
        a.offer?.state === 'PENDING' &&
        !a.offer.expired
      )
        standing.offer = { offerId: a.offer.offerId, slotId: a.slotId };
    }
    return standing;
  } catch {
    return none;
  }
}
