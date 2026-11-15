import { cookies } from 'next/headers';
import { randomUUID } from 'node:crypto';
import { requireUser, checkOrigin, rateLimit, hash, HttpError } from './auth';
import { sessionCookie } from './studio-mode';
import { createSkillAppealHandlers, SkillAppealHttpAuthorityError } from '../skill-appeals/http';
import { adjudicateSkillAppealFromHost, fileSkillAppealFromHost } from './skill-appeals-host';

async function authority<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpError && [401, 403, 429].includes(error.status))
      throw new SkillAppealHttpAuthorityError(error.status as 401 | 403 | 429);
    throw error;
  }
}
/** Actor only from the signed-in session cookie; origin is checked for these commands; filing and deciding use separate per-account throttle buckets. */
export const skillAppealHandlers = createSkillAppealHandlers({
  version: 'v1',
  requestId: randomUUID,
  actor: () =>
    authority(async () => {
      const user = await requireUser();
      const cookie = (await cookies()).get(sessionCookie())?.value;
      if (!cookie) throw new SkillAppealHttpAuthorityError(401);
      return { accountId: user.id, sessionHash: hash(cookie) };
    }),
  checkOrigin: (request) => authority(() => checkOrigin(request)),
  rateLimit: (actor, scope) =>
    authority(() =>
      rateLimit(`skill-appeal-${scope === 'FILE' ? 'file' : 'decide'}:${actor.accountId}`, 20, 60),
    ),
  file: fileSkillAppealFromHost,
  adjudicate: adjudicateSkillAppealFromHost,
});
