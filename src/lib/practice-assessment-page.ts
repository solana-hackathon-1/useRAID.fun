import { z } from 'zod';
import { practiceAssessmentHttpHost } from './practice-assessment-http';
import { PracticeAssessmentHttpError } from '../skills/practice-assessment-http';
import {
  PracticeAssessmentContextSchema,
  readPracticeAssessmentContext,
} from '../skills/practice-assessment-context';
import { runCommandTransaction } from './command-receipts-adapter';
import { db } from './db';
import { practiceReviewReadConfiguration } from './practice-review-reads-host';
import { practiceTrialAssessmentWriteConfiguration } from './practice-trial-assessments-host';
import { practiceAssessmentDecisionWriteConfiguration } from './practice-assessment-decisions-host';
const Path = z.strictObject({ assignmentId: z.uuid(), submissionId: z.uuid() });
export async function loadPracticeAssessmentPage(params: unknown) {
  const path = Path.safeParse(params);
  if (!path.success) return { status: 'NOT_FOUND' as const };
  try {
    const actor = await practiceAssessmentHttpHost.actor();
    await practiceAssessmentHttpHost.rateLimit(actor);
    const result = await runCommandTransaction(db, (tx) =>
      readPracticeAssessmentContext(
        tx,
        actor,
        { version: 'v1', ...path.data, purpose: 'ASSESSMENT_REVIEW' },
        () => practiceReviewReadConfiguration().readsAvailable,
      ),
    );
    if (!practiceReviewReadConfiguration().readsAvailable)
      return { status: 'UNAVAILABLE' as const };
    if (!result) return { status: 'NOT_FOUND' as const };
    const parsed = PracticeAssessmentContextSchema.safeParse(result);
    if (
      !parsed.success ||
      parsed.data.review.assignment.evaluatorAccountId !== actor.accountId ||
      parsed.data.review.assignment.id !== path.data.assignmentId ||
      parsed.data.review.submission.reference.recordId !== path.data.submissionId
    )
      return { status: 'UNAVAILABLE' as const };
    return {
      status: 'READY' as const,
      context: {
        ...parsed.data,
        reviewWritesAvailable:
          practiceTrialAssessmentWriteConfiguration().writesAvailable &&
          parsed.data.references.taxonomyReference.recordId ===
            process.env.PRACTICE_ASSESSMENT_CATALOG_ID,
        decisionWritesAvailable:
          practiceAssessmentDecisionWriteConfiguration().writesAvailable &&
          parsed.data.references.taxonomyReference.recordId ===
            process.env.PRACTICE_ASSESSMENT_CATALOG_ID,
      },
    };
  } catch (error) {
    return {
      status:
        error instanceof PracticeAssessmentHttpError
          ? error.status === 401
            ? ('SIGN_IN' as const)
            : error.status === 429
              ? ('RATE_LIMITED' as const)
              : ('DENIED' as const)
          : ('UNAVAILABLE' as const),
    };
  }
}
