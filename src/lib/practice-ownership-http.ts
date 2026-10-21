import { cookies } from 'next/headers';
import { randomUUID } from 'node:crypto';
import { requireUser, rateLimit, hash, checkOrigin, HttpError } from './auth';
import { sessionCookie } from './studio-mode';
import {
  createPracticeOwnershipHandlers,
  PracticeOwnershipHttpError,
  type PracticeOwnershipHttpHost,
} from '../skills/practice-ownership-http';
import {
  readPracticeTrialOwnershipFromHost,
  recordPracticeTrialOwnershipFromHost,
} from './practice-trial-ownership-host';

async function authority<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpError && [401, 403, 429].includes(error.status))
      throw new PracticeOwnershipHttpError(error.status as 401 | 403 | 429);
    throw error;
  }
}
export const practiceOwnershipHttpHost: PracticeOwnershipHttpHost = {
  version: 'v1',
  requestId: randomUUID,
  origin: (request) => authority(() => checkOrigin(request)),
  actor: () =>
    authority(async () => {
      const user = await requireUser();
      const cookie = (await cookies()).get(sessionCookie())?.value;
      if (!cookie) throw new PracticeOwnershipHttpError(401);
      return { accountId: user.id, sessionHash: hash(cookie) };
    }),
  rateLimit: (actor) => authority(() => rateLimit('practice-ownership:' + actor.accountId, 30, 60)),
  read: readPracticeTrialOwnershipFromHost,
  record: recordPracticeTrialOwnershipFromHost,
};
export const practiceOwnershipHandlers = createPracticeOwnershipHandlers(practiceOwnershipHttpHost);
