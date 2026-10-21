import { z } from 'zod';
import {
  ReadPracticeReviewInputSchema,
  type ReadPracticeReviewInput,
  type PracticeReviewReadRecord,
} from './practice-review-read-storage';
import { PracticeReviewHttpResultSchema } from './practice-review-http';
export type PracticeReviewPageState =
  | { readonly status: 'NOT_FOUND'; readonly scope?: ReadPracticeReviewInput }
  | {
      readonly status: 'SIGN_IN' | 'DENIED' | 'RATE_LIMITED' | 'UNAVAILABLE';
      readonly scope: ReadPracticeReviewInput;
    }
  | {
      readonly status: 'READY';
      readonly scope: ReadPracticeReviewInput;
      readonly review: PracticeReviewReadRecord;
    };
const Params = z.strictObject({ assignmentId: z.uuid(), submissionId: z.uuid() });
const Search = z.strictObject({ purpose: z.string() });
/** Server-only: reuses the actual protected GET; no cache, self-HTTP fetch or client authority. */
export function createPracticeReviewPageLoader(
  get: (request: Request, params: unknown) => Promise<Response>,
) {
  return async (params: unknown, search: unknown): Promise<PracticeReviewPageState> => {
    const path = Params.safeParse(params),
      query = Search.safeParse(search);
    if (!path.success || !query.success) return { status: 'NOT_FOUND' };
    const input = ReadPracticeReviewInputSchema.safeParse({
      version: 'v1',
      ...path.data,
      ...query.data,
    });
    if (!input.success) return { status: 'NOT_FOUND' };
    const scope = input.data;
    try {
      const response = await get(
        new Request('http://raid.internal/?' + new URLSearchParams({ purpose: scope.purpose })),
        path.data,
      );
      if (response.status !== 200) {
        const status =
          response.status === 401
            ? 'SIGN_IN'
            : response.status === 403
              ? 'DENIED'
              : response.status === 404 || response.status === 422
                ? 'NOT_FOUND'
                : response.status === 429
                  ? 'RATE_LIMITED'
                  : 'UNAVAILABLE';
        return { status, scope };
      }
      const parsed = PracticeReviewHttpResultSchema.safeParse(await response.json());
      const review = parsed.success && parsed.data.readsAvailable ? parsed.data.review : null;
      if (
        !review ||
        review.assignment.id !== scope.assignmentId ||
        review.assignment.submissionId !== scope.submissionId ||
        review.assignment.purpose !== scope.purpose
      )
        return { status: 'UNAVAILABLE', scope };
      return { status: 'READY', scope, review };
    } catch {
      return { status: 'UNAVAILABLE', scope };
    }
  };
}
