import { z } from 'zod';
import { practiceOwnershipHttpHost } from './practice-ownership-http';
import { PracticeOwnershipHttpError } from '../skills/practice-ownership-http';
import {
  PracticeOwnershipContextSchema,
  readPracticeOwnershipContext,
} from '../skills/practice-ownership-context';
import { runCommandTransaction } from './command-receipts-adapter';
import { db } from './db';
import { practiceReviewReadConfiguration } from './practice-review-reads-host';
import { practiceTrialOwnershipWriteConfiguration } from './practice-trial-ownership-host';
const Path = z.strictObject({ assignmentId: z.uuid(), submissionId: z.uuid() });
export async function loadPracticeOwnershipPage(params: unknown) {
  const path = Path.safeParse(params);
  if (!path.success) return { status: 'NOT_FOUND' as const };
  try {
    const actor = await practiceOwnershipHttpHost.actor();
    await practiceOwnershipHttpHost.rateLimit(actor);
    const result = await runCommandTransaction(db, (tx) =>
      readPracticeOwnershipContext(
        tx,
        actor,
        { version: 'v1', ...path.data, purpose: 'OWNERSHIP_REVIEW' },
        () => practiceReviewReadConfiguration().readsAvailable,
      ),
    );
    if (!practiceReviewReadConfiguration().readsAvailable)
      return { status: 'UNAVAILABLE' as const };
    if (!result) return { status: 'NOT_FOUND' as const };
    const parsed = PracticeOwnershipContextSchema.safeParse(result);
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
        writesAvailable: practiceTrialOwnershipWriteConfiguration().writesAvailable,
      },
    };
  } catch (error) {
    return {
      status:
        error instanceof PracticeOwnershipHttpError
          ? error.status === 401
            ? ('SIGN_IN' as const)
            : error.status === 429
              ? ('RATE_LIMITED' as const)
              : ('DENIED' as const)
          : ('UNAVAILABLE' as const),
    };
  }
}
