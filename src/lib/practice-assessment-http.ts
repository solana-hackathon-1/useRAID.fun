import { cookies } from 'next/headers';
import { randomUUID } from 'node:crypto';
import { requireUser, rateLimit, hash, checkOrigin, HttpError } from './auth';
import { sessionCookie } from './studio-mode';
import {
  createPracticeAssessmentHandlers,
  PracticeAssessmentHttpError,
  type PracticeAssessmentHttpHost,
} from '../skills/practice-assessment-http';
import {
  readPracticeTrialAssessmentFromHost,
  recordPracticeTrialAssessmentFromHost,
} from './practice-trial-assessments-host';
import {
  readPracticeTrialAssessmentStateFromHost,
  readPracticeAssessmentDecisionFromHost,
  recordPracticeAssessmentDecisionFromHost,
} from './practice-assessment-decisions-host';
async function authority<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpError && [401, 403, 429].includes(error.status))
      throw new PracticeAssessmentHttpError(error.status as 401 | 403 | 429);
    throw error;
  }
}
export const practiceAssessmentHttpHost: PracticeAssessmentHttpHost = {
  version: 'v1',
  requestId: randomUUID,
  origin: (request) => authority(() => checkOrigin(request)),
  actor: () =>
    authority(async () => {
      const user = await requireUser();
      const cookie = (await cookies()).get(sessionCookie())?.value;
      if (!cookie) throw new PracticeAssessmentHttpError(401);
      return { accountId: user.id, sessionHash: hash(cookie) };
    }),
  rateLimit: (actor) =>
    authority(() => rateLimit('practice-assessment:' + actor.accountId, 30, 60)),
  readReview: readPracticeTrialAssessmentFromHost,
  recordReview: recordPracticeTrialAssessmentFromHost,
  readState: readPracticeTrialAssessmentStateFromHost,
  readDecision: readPracticeAssessmentDecisionFromHost,
  recordDecision: recordPracticeAssessmentDecisionFromHost,
};
export const practiceAssessmentHandlers = createPracticeAssessmentHandlers(
  practiceAssessmentHttpHost,
);
