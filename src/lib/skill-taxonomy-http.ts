import { cookies } from 'next/headers';
import { randomUUID } from 'node:crypto';
import { requireUser, checkOrigin, rateLimit, hash, HttpError } from './auth';
import { adminXIds } from './admins';
import { sessionCookie } from './studio-mode';
import {
  createSkillTaxonomyHandlers,
  createSkillTaxonomyReadHandler,
  SkillTaxonomyHttpError,
} from '../skills/taxonomy-http';
import { publishSkillTaxonomyFromHost, readSkillTaxonomyEditorState } from './skill-taxonomy-host';
async function authority<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.status === 401) throw new SkillTaxonomyHttpError(401);
      if (error.status === 403) throw new SkillTaxonomyHttpError(403);
      if (error.status === 429) throw new SkillTaxonomyHttpError(429);
    }
    throw error;
  }
}
const actor = () =>
  authority(async () => {
    const user = await requireUser(true);
    if (!user.xId || !adminXIds().includes(user.xId)) throw new SkillTaxonomyHttpError(403);
    const cookie = (await cookies()).get(sessionCookie())?.value;
    if (!cookie) throw new SkillTaxonomyHttpError(401);
    return { accountId: user.id, sessionHash: hash(cookie) };
  });
export const skillTaxonomyReadHandler = createSkillTaxonomyReadHandler({
  version: 'v1',
  requestId: randomUUID,
  actor,
  read: readSkillTaxonomyEditorState,
});
export const skillTaxonomyHandlers = createSkillTaxonomyHandlers({
  version: 'v1',
  requestId: randomUUID,
  actor,
  checkOrigin: (request) => authority(() => checkOrigin(request)),
  rateLimit: (actor) => authority(() => rateLimit('skill-taxonomy:' + actor.accountId, 30, 60)),
  publish: publishSkillTaxonomyFromHost,
});
