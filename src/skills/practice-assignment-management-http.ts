import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import { createErrorEnvelope, type ErrorCode } from '../contracts/protocol';
import { SkillTaxonomyActorSchema, type SkillTaxonomyActor } from './taxonomy-storage-contracts';
import { PracticeReviewAssignmentError } from './practice-review-assignment-storage';
import {
  PracticeReviewAssignmentHttpError,
  practiceReviewAssignmentPrivateHeaders,
} from './practice-review-assignment-http';
import {
  PracticeAssignmentManagementInputSchema,
  PracticeAssignmentManagementPageSchema,
  PracticeAssignmentManagementResultSchema,
} from './practice-review-assignment-management-contracts';
export interface PracticeAssignmentManagementHttpHost {
  readonly version: 'v1';
  requestId(): string;
  actor(): Promise<SkillTaxonomyActor>;
  rateLimit(actor: SkillTaxonomyActor): void | Promise<void>;
  read(actor: SkillTaxonomyActor, input: unknown): Promise<unknown>;
}
const HostResult = z
  .strictObject({
    version: z.literal('v1'),
    writesAvailable: z.boolean(),
    unavailableReason: z.literal('DISABLED').nullable(),
    result: z.strictObject({
      managerXId: InternalId,
      page: PracticeAssignmentManagementPageSchema,
    }),
  })
  .refine((v) => v.writesAvailable === (v.unavailableReason === null));
function fail(code: PracticeReviewAssignmentError['code']): never {
  throw new PracticeReviewAssignmentError(code);
}
function failure(error: unknown, id: string) {
  let code: ErrorCode = 'SERVICE_UNAVAILABLE';
  if (error instanceof PracticeReviewAssignmentHttpError)
    code =
      error.status === 401
        ? 'AUTHENTICATION_REQUIRED'
        : error.status === 403
          ? 'FORBIDDEN'
          : 'RATE_LIMITED';
  else if (error instanceof PracticeReviewAssignmentError) {
    if (['AUTHENTICATION_REQUIRED', 'ACCOUNT_RESTRICTED', 'FORBIDDEN'].includes(error.code))
      code = error.code as ErrorCode;
    if (error.code === 'INVALID_INPUT') code = 'INVALID_COMMAND';
  }
  const result = createErrorEnvelope(code, id);
  return Response.json(result.body, {
    status: result.status,
    headers: practiceReviewAssignmentPrivateHeaders,
  });
}
/** Read host owns actual scoped X-admin locks, current policy/audit/time and committed delivery. */
export function createPracticeAssignmentManagementHandlers(
  host: PracticeAssignmentManagementHttpHost,
) {
  if (
    host?.version !== 'v1' ||
    ['actor', 'rateLimit', 'read', 'requestId'].some(
      (k) => typeof host[k as keyof PracticeAssignmentManagementHttpHost] !== 'function',
    )
  )
    fail('STORAGE_CONTRACT');
  const get = async (request: Request) => {
    let id = crypto.randomUUID() as string;
    try {
      const parsed = InternalId.safeParse(host.requestId());
      if (parsed.success) id = parsed.data;
    } catch {
      /* Private callback diagnostics are never displayed. */
    }
    try {
      const actor = SkillTaxonomyActorSchema.safeParse(await host.actor());
      if (!actor.success) fail('STORAGE_CONTRACT');
      await host.rateLimit(actor.data);
      if (!['GET', 'HEAD'].includes(request.method))
        return Response.json(
          {
            error: {
              code: 'METHOD_NOT_ALLOWED',
              message: 'Method not allowed.',
              retryable: false,
              requestId: id,
            },
          },
          { status: 405, headers: practiceReviewAssignmentPrivateHeaders },
        );
      const query = new URL(request.url).searchParams;
      if (
        [...query.keys()].some((k) => !['submissionId', 'after'].includes(k)) ||
        query.getAll('submissionId').length > 1 ||
        query.getAll('after').length > 1
      )
        fail('INVALID_INPUT');
      const input = PracticeAssignmentManagementInputSchema.safeParse({
        version: 'v1',
        submissionId: query.get('submissionId'),
        after: query.get('after'),
      });
      if (!input.success) fail('INVALID_INPUT');
      const value = HostResult.safeParse(await host.read(actor.data, input.data));
      if (!value.success) fail('STORAGE_CONTRACT');
      const page = value.data.result.page;
      if (
        page.actorAccountId !== actor.data.accountId ||
        page.submissionId !== input.data.submissionId ||
        page.after !== input.data.after
      )
        fail('STORAGE_CONTRACT');
      const result = PracticeAssignmentManagementResultSchema.parse({
        version: 'v1',
        page,
        writesAvailable: value.data.writesAvailable,
        unavailableReason: value.data.unavailableReason,
      });
      return Response.json(result, { headers: practiceReviewAssignmentPrivateHeaders });
    } catch (error) {
      return failure(error, id);
    }
  };
  return {
    GET: get,
    HEAD: async (request: Request) => {
      const response = await get(request);
      return new Response(null, { status: response.status, headers: response.headers });
    },
  };
}
