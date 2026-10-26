import { cookies } from 'next/headers';
import { randomUUID } from 'node:crypto';
import { requireUser, checkOrigin, rateLimit, hash, HttpError } from './auth';
import { sessionCookie } from './studio-mode';
import { WorkHttpError } from '../work-http/workspace-http';
import { createCreationHandlers } from '../work-http/creation-http';
import {
  creationStateFromHost,
  saveDraftFromHost,
  publishDraftFromHost,
  recommendFromHost,
} from './work-creation-host';

async function authority<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof HttpError && [401, 403, 429].includes(e.status))
      throw new WorkHttpError(e.status as 401 | 403 | 429);
    throw e;
  }
}
export const creationHandlers = createCreationHandlers({
  version: 'v1',
  requestId: randomUUID,
  actor: () =>
    authority(async () => {
      const u = await requireUser(),
        cookie = (await cookies()).get(sessionCookie())?.value;
      if (!cookie) throw new WorkHttpError(401);
      return { accountId: u.id, sessionHash: hash(cookie) };
    }),
  checkOrigin: (r) => authority(() => checkOrigin(r)),
  rateLimit: (a) => authority(() => rateLimit('work-creation:' + a.accountId, 60, 60)),
  state: creationStateFromHost,
  saveDraft: saveDraftFromHost,
  publishDraft: publishDraftFromHost,
  recommend: recommendFromHost,
});
