import { cookies } from 'next/headers';
import { randomUUID } from 'node:crypto';
import { requireUser, rateLimit, hash, HttpError } from './auth';
import { sessionCookie } from './studio-mode';
import {
  createOwnSkillAssessmentHandlers,
  OwnSkillAssessmentHttpError,
} from '../skills/own-assessment-http';
import { readOwnSkillAssessmentFromHost } from './own-skill-assessments-host';
async function authority<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof HttpError && [401, 403, 429].includes(e.status))
      throw new OwnSkillAssessmentHttpError(e.status as 401 | 403 | 429);
    throw e;
  }
}
export const ownSkillAssessmentHandlers = createOwnSkillAssessmentHandlers({
  version: 'v1',
  requestId: randomUUID,
  actor: () =>
    authority(async () => {
      const user = await requireUser(),
        cookie = (await cookies()).get(sessionCookie())?.value;
      if (!cookie) throw new OwnSkillAssessmentHttpError(401);
      return { accountId: user.id, sessionHash: hash(cookie) };
    }),
  rateLimit: (actor) =>
    authority(() => rateLimit('own-skill-assessment:' + actor.accountId, 30, 60)),
  read: readOwnSkillAssessmentFromHost,
});
