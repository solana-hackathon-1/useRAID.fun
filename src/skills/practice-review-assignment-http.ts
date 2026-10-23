import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import { createErrorEnvelope, type ErrorCode } from '../contracts/protocol';
import { CommandReceiptError } from '../command-receipts';
import { readBoundedJson, JsonBodyFailure } from '../http-contracts/json';
import { SkillTaxonomyActorSchema, type SkillTaxonomyActor } from './taxonomy-storage-contracts';
import {
  IssuePracticeReviewAssignmentInputSchema,
  RevokePracticeReviewAssignmentInputSchema,
  PracticeReviewAssignmentError,
  type PracticeReviewAssignmentCommand,
} from './practice-review-assignment-storage';

export class PracticeReviewAssignmentHttpError extends Error {
  constructor(readonly status: 401 | 403 | 429) {
    super('HTTP_AUTHORITY_DENIED');
    this.name = 'PracticeReviewAssignmentHttpError';
  }
}
/** Host owns current admin authority, whole-transaction retry and commit before delivery. */
export interface PracticeReviewAssignmentHttpHost {
  readonly version: 'v1';
  requestId(): string;
  origin(request: Request): void | Promise<void>;
  actor(): Promise<SkillTaxonomyActor>;
  rateLimit(actor: SkillTaxonomyActor): void | Promise<void>;
  issue(command: PracticeReviewAssignmentCommand): Promise<unknown>;
  revoke(command: PracticeReviewAssignmentCommand): Promise<unknown>;
}
export const practiceReviewAssignmentPrivateHeaders = Object.freeze({
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
});
export {
  PracticeReviewAssignmentIssueResultSchema,
  PracticeReviewAssignmentRevokeResultSchema,
} from './practice-review-assignment-contracts';
import {
  PracticeReviewAssignmentIssueResultSchema,
  PracticeReviewAssignmentRevokeResultSchema,
} from './practice-review-assignment-contracts';
const Params = z.strictObject({ assignmentId: z.uuid() });
const MAXIMUM_BODY_BYTES = 16384;
function fail(code: PracticeReviewAssignmentError['code']): never {
  throw new PracticeReviewAssignmentError(code);
}
function failure(error: unknown, requestId: string) {
  let code: ErrorCode = 'SERVICE_UNAVAILABLE';
  if (error instanceof PracticeReviewAssignmentHttpError)
    code =
      error.status === 401
        ? 'AUTHENTICATION_REQUIRED'
        : error.status === 403
          ? 'FORBIDDEN'
          : 'RATE_LIMITED';
  else if (error instanceof JsonBodyFailure) code = 'INVALID_COMMAND';
  else if (error instanceof CommandReceiptError && error.code === 'IDEMPOTENCY_KEY_REUSED')
    code = error.code;
  else if (error instanceof PracticeReviewAssignmentError) {
    switch (error.code) {
      case 'INVALID_INPUT':
      case 'EXPIRY_INVALID':
        code = 'INVALID_COMMAND';
        break;
      case 'AUTHENTICATION_REQUIRED':
        code = 'AUTHENTICATION_REQUIRED';
        break;
      case 'ACCOUNT_RESTRICTED':
        code = 'ACCOUNT_RESTRICTED';
        break;
      case 'FORBIDDEN':
      case 'SELF_REVIEW_FORBIDDEN':
        code = 'FORBIDDEN';
        break;
      case 'RESOURCE_UNAVAILABLE':
        code = 'NOT_FOUND';
        break;
      case 'ALREADY_REVOKED':
        code = 'REVISION_CHANGED';
        break;
      default:
        break;
    }
  }
  const result = createErrorEnvelope(code, requestId);
  return Response.json(result.body, {
    status: error instanceof JsonBodyFailure ? error.status : result.status,
    headers: practiceReviewAssignmentPrivateHeaders,
  });
}
/** Administrator appointment commands. HTTP adds no authority beyond the storage commands. */
export function createPracticeReviewAssignmentHandlers(host: PracticeReviewAssignmentHttpHost) {
  if (
    host?.version !== 'v1' ||
    ['requestId', 'origin', 'actor', 'rateLimit', 'issue', 'revoke'].some(
      (key) => typeof host[key as keyof PracticeReviewAssignmentHttpHost] !== 'function',
    )
  )
    fail('STORAGE_CONTRACT');
  async function handle<T>(
    request: Request,
    work: (ctx: {
      actor: SkillTaxonomyActor;
      key: string;
      requestId: string;
      path: z.output<typeof Params> | null;
      body: () => Promise<unknown>;
    }) => Promise<T>,
    params?: unknown,
  ) {
    let requestId: string = crypto.randomUUID();
    try {
      const id = InternalId.safeParse(host.requestId());
      if (id.success) requestId = id.data;
    } catch {
      /* Diagnostics remain private. */
    }
    // Observe rejection immediately, including when origin/authentication fails first.
    const resolved = Promise.resolve(params).then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const }),
    );
    try {
      await host.origin(request);
      const actor = SkillTaxonomyActorSchema.safeParse(await host.actor());
      if (!actor.success) fail('STORAGE_CONTRACT');
      await host.rateLimit(actor.data);
      if (new URL(request.url).searchParams.size !== 0) fail('INVALID_INPUT');
      let path: z.output<typeof Params> | null = null;
      if (params !== undefined) {
        const route = await resolved;
        if (!route.ok) fail('STORAGE_UNAVAILABLE');
        const parsed = Params.safeParse(route.value);
        if (!parsed.success) fail('INVALID_INPUT');
        path = parsed.data;
      }
      const key = InternalId.safeParse(request.headers.get('Idempotency-Key'));
      if (!key.success) fail('INVALID_INPUT');
      const result = await work({
        actor: actor.data,
        key: key.data,
        requestId,
        path,
        body: () => readBoundedJson(request, { maximumBytes: MAXIMUM_BODY_BYTES }),
      });
      return Response.json(result, { headers: practiceReviewAssignmentPrivateHeaders });
    } catch (error) {
      return failure(error, requestId);
    }
  }
  return {
    issue: (request: Request) =>
      handle(request, async ({ actor, key, requestId, body }) => {
        const input = IssuePracticeReviewAssignmentInputSchema.safeParse(await body());
        if (!input.success) fail('INVALID_INPUT');
        const result = PracticeReviewAssignmentIssueResultSchema.safeParse(
          await host.issue({ actor, input: input.data, idempotencyKey: key, requestId }),
        );
        if (!result.success) fail('STORAGE_CONTRACT');
        const a = result.data.assignment;
        if (
          a.submissionId !== input.data.submissionId ||
          a.evaluatorAccountId !== input.data.evaluatorAccountId ||
          a.purpose !== input.data.purpose ||
          a.expiresAt !== input.data.expiresAt ||
          a.reason !== input.data.reason ||
          a.issuedByAccountId !== actor.accountId
        )
          fail('STORAGE_CONTRACT');
        // A write gate closing after commit does not hide the committed outcome.
        return result.data;
      }),
    revoke: (request: Request, params: unknown) =>
      handle(
        request,
        async ({ actor, key, requestId, path, body }) => {
          if (!path) fail('INVALID_INPUT');
          const input = RevokePracticeReviewAssignmentInputSchema.safeParse(await body());
          if (!input.success || input.data.assignmentId !== path.assignmentId)
            fail('INVALID_INPUT');
          const result = PracticeReviewAssignmentRevokeResultSchema.safeParse(
            await host.revoke({ actor, input: input.data, idempotencyKey: key, requestId }),
          );
          if (!result.success) fail('STORAGE_CONTRACT');
          const r = result.data.revocation;
          if (
            r.assignmentId !== input.data.assignmentId ||
            r.reason !== input.data.reason ||
            r.revokedByAccountId !== actor.accountId
          )
            fail('STORAGE_CONTRACT');
          return result.data;
        },
        params ?? {},
      ),
  };
}
