import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import { createErrorEnvelope, type ErrorCode } from '../contracts/protocol';
import {
  SkillTaxonomyActorSchema,
  SkillTaxonomyStorageError,
  type SkillTaxonomyActor,
} from './taxonomy-storage-contracts';
import { PracticeReviewHttpError, practiceReviewPrivateHeaders } from './practice-review-http';
import {
  PracticeReviewInboxHostResultSchema,
  PracticeReviewInboxInputSchema,
} from './practice-review-inbox-contracts';
export interface PracticeReviewInboxHttpHost {
  readonly version: 'v1';
  requestId(): string;
  actor(): Promise<SkillTaxonomyActor>;
  rateLimit(actor: SkillTaxonomyActor): void | Promise<void>;
  list(actor: SkillTaxonomyActor, input: unknown): Promise<unknown>;
}
const Envelope = z
  .strictObject({
    version: z.literal('v1'),
    readsAvailable: z.boolean(),
    unavailableReason: z.literal('DISABLED').nullable(),
    result: PracticeReviewInboxHostResultSchema.nullable(),
  })
  .refine(
    (r) =>
      r.readsAvailable === (r.unavailableReason === null) &&
      (r.readsAvailable || r.result === null),
  );
function fail(code: SkillTaxonomyStorageError['code']): never {
  throw new SkillTaxonomyStorageError(code);
}
function failure(error: unknown, id: string) {
  let code: ErrorCode = 'SERVICE_UNAVAILABLE';
  if (error instanceof PracticeReviewHttpError)
    code =
      error.status === 401
        ? 'AUTHENTICATION_REQUIRED'
        : error.status === 403
          ? 'FORBIDDEN'
          : 'RATE_LIMITED';
  if (error instanceof SkillTaxonomyStorageError) {
    if (['AUTHENTICATION_REQUIRED', 'ACCOUNT_RESTRICTED', 'FORBIDDEN'].includes(error.code))
      code = error.code as ErrorCode;
    if (error.code === 'INVALID_INPUT') code = 'INVALID_COMMAND';
  }
  const result = createErrorEnvelope(code, id);
  return Response.json(result.body, {
    status: result.status,
    headers: practiceReviewPrivateHeaders,
  });
}
/** Host owns current metadata authority, audit, whole retries and commit before delivery. */
export function createPracticeReviewInboxHandlers(host: PracticeReviewInboxHttpHost) {
  if (
    host?.version !== 'v1' ||
    ['actor', 'rateLimit', 'list', 'requestId'].some(
      (key) => typeof host[key as keyof PracticeReviewInboxHttpHost] !== 'function',
    )
  )
    fail('STORAGE_CONTRACT');
  const get = async (request: Request) => {
    let requestId = crypto.randomUUID() as string;
    try {
      const id = InternalId.safeParse(host.requestId());
      if (id.success) requestId = id.data;
    } catch {
      /* Keep callback diagnostics private. */
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
              requestId,
            },
          },
          { status: 405, headers: practiceReviewPrivateHeaders },
        );
      const query = new URL(request.url).searchParams;
      if (query.size > 1 || (query.size === 1 && query.getAll('after').length !== 1))
        fail('INVALID_INPUT');
      const input = PracticeReviewInboxInputSchema.safeParse({
        version: 'v1',
        after: query.get('after'),
      });
      if (!input.success) fail('INVALID_INPUT');
      const result = Envelope.safeParse(await host.list(actor.data, input.data));
      if (!result.success || !result.data.readsAvailable || !result.data.result)
        fail('STORAGE_CONTRACT');
      const bound = result.data.result;
      if (
        bound.accountId !== actor.data.accountId ||
        bound.page.entries.some(
          (entry) => input.data.after !== null && entry.assignmentId <= input.data.after,
        )
      )
        fail('STORAGE_CONTRACT');
      return Response.json(bound.page, { headers: practiceReviewPrivateHeaders });
    } catch (error) {
      return failure(error, requestId);
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
