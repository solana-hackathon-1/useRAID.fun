import { cookies } from 'next/headers';
import { randomUUID } from 'node:crypto';
import { requireUser, checkOrigin, rateLimit, hash, HttpError } from './auth';
import { sessionCookie } from './studio-mode';
import { draftUpdate, listUpdatesState, publishUpdate, withdrawUpdate } from './guild-updates-host';
import {
  createGuildUpdatesHandlers,
  GuildUpdatesHttpError,
} from '../guild-profiles/guild-updates-http';
async function authority<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpError && [401, 403, 429].includes(error.status))
      throw new GuildUpdatesHttpError(error.status as 401 | 403 | 429);
    throw error;
  }
}
export const guildUpdatesHandlers = createGuildUpdatesHandlers({
  version: 'v1',
  requestId: randomUUID,
  actor: () =>
    authority(async () => {
      const user = await requireUser();
      const cookie = (await cookies()).get(sessionCookie())?.value;
      if (!cookie) throw new GuildUpdatesHttpError(401);
      return { accountId: user.id, sessionHash: hash(cookie) };
    }),
  checkOrigin: (request) => authority(() => checkOrigin(request)),
  rateLimit: (actor) => authority(() => rateLimit(`guild-updates:${actor.accountId}`, 30, 60)),
  list: listUpdatesState,
  draft: draftUpdate,
  publish: publishUpdate,
  withdraw: withdrawUpdate,
});
