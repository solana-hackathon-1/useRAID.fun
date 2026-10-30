import { cookies } from 'next/headers';
import { randomUUID } from 'node:crypto';
import { requireUser, checkOrigin, rateLimit, hash, HttpError } from './auth';
import { sessionCookie } from './studio-mode';
import { GuildHttpAuthorityError } from '../guild-profiles/guild-http-shared';
import type { GuildActor } from '../guild-profiles/guild-storage-contracts';

async function authority<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpError && [401, 403, 429].includes(error.status))
      throw new GuildHttpAuthorityError(error.status as 401 | 403 | 429);
    throw error;
  }
}
/**
 * The Root host's shared session half of every Guild management transport: the actor comes only from the signed-in
 * session cookie, origin is checked for commands, and reads and commands are throttled in separate per-account buckets
 * (`<bucket>-read` 120/60s, `<bucket>` 30/60s) so polling can never block a write.
 */
export const guildSessionHost = (bucket: string) => ({
  version: 'v1' as const,
  requestId: randomUUID,
  actor: (): Promise<GuildActor> =>
    authority(async () => {
      const user = await requireUser();
      const cookie = (await cookies()).get(sessionCookie())?.value;
      if (!cookie) throw new GuildHttpAuthorityError(401);
      return { accountId: user.id, sessionHash: hash(cookie) };
    }),
  checkOrigin: (request: Request) => authority(() => checkOrigin(request)),
  rateLimit: (actor: GuildActor, scope: 'READ' | 'WRITE') =>
    authority(() =>
      scope === 'READ'
        ? rateLimit(`${bucket}-read:${actor.accountId}`, 120, 60)
        : rateLimit(`${bucket}:${actor.accountId}`, 30, 60),
    ),
});
