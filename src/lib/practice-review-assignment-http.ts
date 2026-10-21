import { cookies } from 'next/headers';
import { randomUUID } from 'node:crypto';
import { requireUser, checkOrigin, rateLimit, hash, HttpError } from './auth';
import { adminXIds } from './admins';
import { sessionCookie } from './studio-mode';
import {
  createPracticeReviewAssignmentHandlers,
  PracticeReviewAssignmentHttpError,
  type PracticeReviewAssignmentHttpHost,
} from '../skills/practice-review-assignment-http';
import {
  issuePracticeReviewAssignmentFromHost,
  revokePracticeReviewAssignmentFromHost,
} from './practice-review-assignments-host';

async function authority<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpError && [401, 403, 429].includes(error.status))
      throw new PracticeReviewAssignmentHttpError(error.status as 401 | 403 | 429);
    throw error;
  }
}
// Pre-check mirrors the storage command, which re-verifies role, X session and policy under locks.
export const practiceReviewAssignmentHttpHost: PracticeReviewAssignmentHttpHost = {
  version: 'v1',
  requestId: randomUUID,
  origin: (request) => authority(() => checkOrigin(request)),
  actor: () =>
    authority(async () => {
      const user = await requireUser(true);
      if (!user.xId || !adminXIds().includes(user.xId))
        throw new PracticeReviewAssignmentHttpError(403);
      const cookie = (await cookies()).get(sessionCookie())?.value;
      if (!cookie) throw new PracticeReviewAssignmentHttpError(401);
      return { accountId: user.id, sessionHash: hash(cookie) };
    }),
  rateLimit: (actor) =>
    authority(() => rateLimit('practice-review-assignments:' + actor.accountId, 30, 60)),
  issue: issuePracticeReviewAssignmentFromHost,
  revoke: revokePracticeReviewAssignmentFromHost,
};
export const practiceReviewAssignmentHandlers = createPracticeReviewAssignmentHandlers(
  practiceReviewAssignmentHttpHost,
);
