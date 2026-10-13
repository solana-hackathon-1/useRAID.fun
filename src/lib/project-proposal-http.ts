import { cookies } from 'next/headers';
import { randomUUID } from 'node:crypto';
import { requireUser, checkOrigin, rateLimit, hash, HttpError } from './auth';
import { sessionCookie } from './studio-mode';
import {
  createGuildProjectProposalHandlers,
  GuildProjectProposalHttpError,
} from '../guild-profiles/project-proposal-http';
import { readProjectProposalState, saveProjectProposal } from './project-proposal-host';
async function authority<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpError && [401, 403, 429].includes(error.status))
      throw new GuildProjectProposalHttpError(error.status as 401 | 403 | 429);
    throw error;
  }
}
export const projectProposalHandlers = createGuildProjectProposalHandlers({
  version: 'v1',
  requestId: randomUUID,
  actor: () =>
    authority(async () => {
      const user = await requireUser();
      const cookie = (await cookies()).get(sessionCookie())?.value;
      if (!cookie) throw new GuildProjectProposalHttpError(401);
      return { accountId: user.id, actorAccountId: user.id, sessionHash: hash(cookie) };
    }),
  checkOrigin: (request) => authority(() => checkOrigin(request)),
  rateLimit: (actor) => authority(() => rateLimit('project-proposal:' + actor.accountId, 30, 60)),
  read: readProjectProposalState,
  save: saveProjectProposal,
});
