import { z } from 'zod';
import {
  PracticeAssignmentManagementInputSchema,
  PracticeAssignmentManagementResultSchema,
  type PracticeAssignmentManagementContext,
} from './practice-review-assignment-management-contracts';
import { assignmentManagementEndpoint } from './practice-assignment-manager-client';
export type PracticeAssignmentManagementPageState =
  | { status: 'READY'; context: PracticeAssignmentManagementContext }
  | { status: 'SIGN_IN' | 'DENIED' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'NOT_FOUND' };
/** Server-only dispatcher owns actual current auth/commit/cache policy; no self-HTTP request. */
export function createPracticeAssignmentManagementLoader(
  get: (request: Request) => Promise<Response>,
) {
  return async (search: unknown): Promise<PracticeAssignmentManagementPageState> => {
    const query = z
      .strictObject({ submissionId: z.string().optional(), after: z.string().optional() })
      .safeParse(search);
    if (!query.success) return { status: 'NOT_FOUND' };
    const input = PracticeAssignmentManagementInputSchema.safeParse({
      version: 'v1',
      submissionId: query.data.submissionId ?? null,
      after: query.data.after ?? null,
    });
    if (!input.success) return { status: 'NOT_FOUND' };
    try {
      const response = await get(
        new Request('http://raid.internal' + assignmentManagementEndpoint(input.data)),
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
      const value = PracticeAssignmentManagementResultSchema.safeParse(await response.json());
      if (
        !value.success ||
        value.data.page.submissionId !== input.data.submissionId ||
        value.data.page.after !== input.data.after
      )
        return { status: 'UNAVAILABLE' };
      return { status: 'READY', context: value.data };
    } catch {
      return { status: 'UNAVAILABLE' };
    }
  };
}
