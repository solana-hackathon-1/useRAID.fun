import { z } from 'zod';
import {
  PracticeReviewInboxInputSchema,
  PracticeReviewInboxPageSchema,
  type PracticeReviewInboxPage,
} from './practice-review-inbox-contracts';
export type PracticeReviewInboxState =
  | { status: 'READY'; page: PracticeReviewInboxPage }
  | { status: 'SIGN_IN' | 'DENIED' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'NOT_FOUND' };
/** Server host injects protected GET, including current identity/commit/private cache policy. */
export function createPracticeReviewInboxLoader(get: (request: Request) => Promise<Response>) {
  return async (search: unknown): Promise<PracticeReviewInboxState> => {
    const query = z.strictObject({ after: z.string().optional() }).safeParse(search);
    if (!query.success) return { status: 'NOT_FOUND' };
    const input = PracticeReviewInboxInputSchema.safeParse({
      version: 'v1',
      after: query.data.after ?? null,
    });
    if (!input.success) return { status: 'NOT_FOUND' };
    try {
      const response = await get(
        new Request(
          'http://raid.internal/' +
            (input.data.after ? '?after=' + encodeURIComponent(input.data.after) : ''),
        ),
      );
      if (response.status !== 200)
        return {
          status:
            response.status === 401
              ? 'SIGN_IN'
              : response.status === 403
                ? 'DENIED'
                : response.status === 429
                  ? 'RATE_LIMITED'
                  : response.status === 422
                    ? 'NOT_FOUND'
                    : 'UNAVAILABLE',
        };
      const page = PracticeReviewInboxPageSchema.safeParse(await response.json());
      if (
        !page.success ||
        page.data.entries.some(
          (entry) => input.data.after !== null && entry.assignmentId <= input.data.after,
        )
      )
        return { status: 'UNAVAILABLE' };
      return { status: 'READY', page: page.data };
    } catch {
      return { status: 'UNAVAILABLE' };
    }
  };
}
