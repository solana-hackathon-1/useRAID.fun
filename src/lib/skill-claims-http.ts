import { cookies } from 'next/headers';
import { randomUUID } from 'node:crypto';
import { requireUser, checkOrigin, rateLimit, hash, HttpError } from './auth';
import { sessionCookie } from './studio-mode';
import { createSkillClaimHandlers, SkillClaimHttpError } from '../skills/http';
import {
  readSkillClaimState,
  readSkillCatalogState,
  saveSkillClaimFromHost,
} from './skill-claims-host';
async function authority<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.status === 401) throw new SkillClaimHttpError(401);
      if (error.status === 403) throw new SkillClaimHttpError(403);
      if (error.status === 429) throw new SkillClaimHttpError(429);
    }
    throw error;
  }
}
export const skillClaimHandlers = createSkillClaimHandlers({
  version: 'v1',
  requestId: randomUUID,
  actor: () =>
    authority(async () => {
      const user = await requireUser();
      const cookie = (await cookies()).get(sessionCookie())?.value;
      if (!cookie) throw new SkillClaimHttpError(401);
      return { accountId: user.id, sessionHash: hash(cookie) };
    }),
  checkOrigin: (request) => authority(() => checkOrigin(request)),
  rateLimit: (actor) => authority(() => rateLimit('skill-claim:' + actor.accountId, 30, 60)),
  read: readSkillClaimState,
  save: saveSkillClaimFromHost,
  readCatalog: readSkillCatalogState,
});
