import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import { createErrorEnvelope, type ErrorCode } from '../contracts/protocol';
import { SkillTaxonomyActorSchema, type SkillTaxonomyActor } from './taxonomy-storage-contracts';
import {
  ReadPracticeReviewInputSchema,
  PracticeReviewReadRecordSchema,
  PracticeReviewReadError,
} from './practice-review-read-storage';
export class PracticeReviewHttpError extends Error {
  constructor(readonly status: 401 | 403 | 429) {
    super('HTTP_AUTHORITY_DENIED');
    this.name = 'PracticeReviewHttpError';
  }
}
export interface PracticeReviewHttpHost {
  readonly version: 'v1';
  requestId(): string;
  actor(): Promise<SkillTaxonomyActor>;
  rateLimit(actor: SkillTaxonomyActor): void | Promise<void>;
  read(actor: SkillTaxonomyActor, input: unknown): Promise<unknown>;
}
export const practiceReviewPrivateHeaders = Object.freeze({
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
});
const Params = z.strictObject({ assignmentId: z.uuid(), submissionId: z.uuid() });
export const PracticeReviewHttpResultSchema = z
  .strictObject({
    version: z.literal('v1'),
    readsAvailable: z.boolean(),
    unavailableReason: z.literal('DISABLED').nullable(),
    review: PracticeReviewReadRecordSchema.nullable(),
  })
  .refine(
    (r) =>
      r.readsAvailable === (r.unavailableReason === null) &&
      (r.readsAvailable || r.review === null),
  );
function fail(code: PracticeReviewReadError['code']): never {
  throw new PracticeReviewReadError(code);
}
function failure(error: unknown, requestId: string) {
  let code: ErrorCode = 'SERVICE_UNAVAILABLE';
  if (error instanceof PracticeReviewHttpError)
    code =
      error.status === 401
        ? 'AUTHENTICATION_REQUIRED'
        : error.status === 403
          ? 'FORBIDDEN'
          : 'RATE_LIMITED';
  else if (error instanceof PracticeReviewReadError) {
    if (['AUTHENTICATION_REQUIRED', 'ACCOUNT_RESTRICTED', 'FORBIDDEN'].includes(error.code))
      code = error.code as ErrorCode;
    else if (error.code === 'RESOURCE_UNAVAILABLE') code = 'NOT_FOUND';
    else if (error.code === 'INVALID_INPUT') code = 'INVALID_COMMAND';
  }
  const result = createErrorEnvelope(code, requestId);
  return Response.json(result.body, {
    status: result.status,
    headers: practiceReviewPrivateHeaders,
  });
}
/** Current exact-scope SQL authority and commit-before-delivery belong to the injected host. */
export function createPracticeReviewHandlers(host: PracticeReviewHttpHost) {
  if (
    host?.version !== 'v1' ||
    ['actor', 'rateLimit', 'read', 'requestId'].some(
      (key) => typeof host[key as keyof PracticeReviewHttpHost] !== 'function',
    )
  )
    fail('STORAGE_CONTRACT');
  return {
    async GET(request: Request, params: unknown) {
      let requestId: string = crypto.randomUUID();
      try {
        const id = InternalId.safeParse(host.requestId());
        if (id.success) requestId = id.data;
      } catch {
        /* Callback diagnostics stay private. */
      }
      // Attach to asynchronous route params immediately, even when authentication fails first.
      const resolvedParams = Promise.resolve(params).then(
        (value) => ({ ok: true as const, value }),
        () => ({ ok: false as const }),
      );
      try {
        const actor = SkillTaxonomyActorSchema.safeParse(await host.actor());
        if (!actor.success) fail('STORAGE_CONTRACT');
        await host.rateLimit(actor.data);
        if (request.method !== 'GET')
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
        const route = await resolvedParams;
        if (!route.ok) fail('STORAGE_UNAVAILABLE');
        const path = Params.safeParse(route.value);
        const query = new URL(request.url).searchParams;
        if (!path.success || query.size !== 1 || query.getAll('purpose').length !== 1)
          fail('INVALID_INPUT');
        const input = ReadPracticeReviewInputSchema.safeParse({
          version: 'v1',
          ...path.data,
          purpose: query.get('purpose'),
        });
        if (!input.success) fail('INVALID_INPUT');
        const parsed = PracticeReviewHttpResultSchema.safeParse(
          await host.read(actor.data, input.data),
        );
        if (!parsed.success) fail('STORAGE_CONTRACT');
        if (!parsed.data.readsAvailable) fail('STORAGE_UNAVAILABLE');
        const review = parsed.data.review;
        if (!review) fail('RESOURCE_UNAVAILABLE');
        if (
          review.assignment.id !== input.data.assignmentId ||
          review.assignment.submissionId !== input.data.submissionId ||
          review.assignment.purpose !== input.data.purpose ||
          review.assignment.evaluatorAccountId !== actor.data.accountId
        )
          fail('STORAGE_CONTRACT');
        return Response.json(parsed.data, { headers: practiceReviewPrivateHeaders });
      } catch (error) {
        return failure(error, requestId);
      }
    },
  };
}
