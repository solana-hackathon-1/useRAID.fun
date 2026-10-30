import { cookies } from 'next/headers';
import { randomUUID } from 'node:crypto';
import { requireUser, checkOrigin, rateLimit, hash, HttpError } from './auth';
import { sessionCookie } from './studio-mode';
import {
  createPartyFromHost,
  proposePartyRosterFromHost,
  readPartyProposalFromHost,
  recordPartyConsentFromHost,
} from './party-host';
import { createPartyHandlers, PartyHttpError } from '../parties/party-http';

async function authority<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpError && [401, 403, 429].includes(error.status))
      throw new PartyHttpError(error.status as 401 | 403 | 429);
    throw error;
  }
}
export const partyHandlers = createPartyHandlers({
  version: 'v1',
  requestId: randomUUID,
  actor: () =>
    authority(async () => {
      const user = await requireUser();
      const cookie = (await cookies()).get(sessionCookie())?.value;
      if (!cookie) throw new PartyHttpError(401);
      return { accountId: user.id, sessionHash: hash(cookie) };
    }),
  checkOrigin: (request) => authority(() => checkOrigin(request)),
  // Separate per-account scopes: polling a proposal can never block a consent.
  rateLimit: (actor, scope) =>
    authority(() =>
      scope === 'READ'
        ? rateLimit(`party-read:${actor.accountId}`, 120, 60)
        : rateLimit(`party:${actor.accountId}`, 30, 60),
    ),
  create: createPartyFromHost,
  propose: proposePartyRosterFromHost,
  consent: recordPartyConsentFromHost,
  read: readPartyProposalFromHost,
});
