import { cookies } from 'next/headers';
import { randomUUID } from 'node:crypto';
import { requireUser, checkOrigin, rateLimit, hash, HttpError } from './auth';
import { sessionCookie } from './studio-mode';
import { editProfile, readProfileState } from './guild-profile-host';
import {
  createGuildProfileHandlers,
  GuildProfileHttpError,
} from '../guild-profiles/guild-profile-http';
async function authority<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpError && [401, 403, 429].includes(error.status))
      throw new GuildProfileHttpError(error.status as 401 | 403 | 429);
    throw error;
  }
}
export const guildProfileHandlers = createGuildProfileHandlers({
  version: 'v1',
  requestId: randomUUID,
  actor: () =>
    authority(async () => {
      const user = await requireUser();
      const cookie = (await cookies()).get(sessionCookie())?.value;
      if (!cookie) throw new GuildProfileHttpError(401);
      return { accountId: user.id, sessionHash: hash(cookie) };
    }),
  checkOrigin: (request) => authority(() => checkOrigin(request)),
  rateLimit: (actor, scope) =>
    authority(() =>
      scope === 'READ'
        ? rateLimit(`guild-profile-read:${actor.accountId}`, 120, 60)
        : rateLimit(`guild-profile:${actor.accountId}`, 30, 60),
    ),
  read: readProfileState,
  edit: editProfile,
});
