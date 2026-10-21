import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import { createErrorEnvelope, type ErrorCode } from '../contracts/protocol';
import { CommandReceiptError } from '../command-receipts';
import { readBoundedJson, JsonBodyFailure } from '../http-contracts/json';
import { SkillTaxonomyActorSchema, type SkillTaxonomyActor } from './taxonomy-storage-contracts';
import {
  RecordPracticeTrialOwnershipInputSchema,
  ReadPracticeTrialOwnershipInputSchema,
  PracticeTrialOwnershipError,
  type PracticeTrialOwnershipCommand,
} from './practice-trial-ownership-storage';

export class PracticeOwnershipHttpError extends Error {
  constructor(readonly status: 401 | 403 | 429) {
    super('HTTP_AUTHORITY_DENIED');
    this.name = 'PracticeOwnershipHttpError';
  }
}
export interface PracticeOwnershipHttpHost {
  readonly version: 'v1';
  requestId(): string;
  origin(request: Request): void | Promise<void>;
  actor(): Promise<SkillTaxonomyActor>;
  rateLimit(actor: SkillTaxonomyActor): void | Promise<void>;
  read(actor: SkillTaxonomyActor, input: unknown): Promise<unknown>;
  record(command: PracticeTrialOwnershipCommand): Promise<unknown>;
}
export const practiceOwnershipPrivateHeaders = Object.freeze({
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
});
const Params = z.strictObject({ assignmentId: z.uuid(), submissionId: z.uuid() });
export {
  PracticeOwnershipHttpReadResultSchema,
  PracticeOwnershipHttpWriteResultSchema,
} from './practice-ownership-results';
import {
  PracticeOwnershipHttpReadResultSchema,
  PracticeOwnershipHttpWriteResultSchema,
} from './practice-ownership-results';
function fail(code: PracticeTrialOwnershipError['code']): never {
  throw new PracticeTrialOwnershipError(code);
}
function failure(error: unknown, requestId: string) {
  let code: ErrorCode = 'SERVICE_UNAVAILABLE';
  if (error instanceof PracticeOwnershipHttpError)
    code =
      error.status === 401
        ? 'AUTHENTICATION_REQUIRED'
        : error.status === 403
          ? 'FORBIDDEN'
          : 'RATE_LIMITED';
  else if (error instanceof JsonBodyFailure) code = 'INVALID_COMMAND';
  else if (error instanceof CommandReceiptError && error.code === 'IDEMPOTENCY_KEY_REUSED')
    code = error.code;
  else if (error instanceof PracticeTrialOwnershipError) {
    if (
      error.code === 'AUTHENTICATION_REQUIRED' ||
      error.code === 'ACCOUNT_RESTRICTED' ||
      error.code === 'REVISION_CHANGED'
    )
      code = error.code;
    else if (error.code === 'INVALID_INPUT') code = 'INVALID_COMMAND';
    else if (error.code === 'RESOURCE_UNAVAILABLE') code = 'NOT_FOUND';
  }
  const result = createErrorEnvelope(code, requestId);
  return Response.json(result.body, {
    status: error instanceof JsonBodyFailure ? error.status : result.status,
    headers: practiceOwnershipPrivateHeaders,
  });
}
function same(
  a: Readonly<{ recordId: string; revision: number }>,
  b: Readonly<{ recordId: string; revision: number }>,
) {
  return a.recordId === b.recordId && a.revision === b.revision;
}
/** Host owns current SQL authority, whole-transaction retry and commit before delivery. */
export function createPracticeOwnershipHandlers(host: PracticeOwnershipHttpHost) {
  if (
    host?.version !== 'v1' ||
    ['requestId', 'origin', 'actor', 'rateLimit', 'read', 'record'].some(
      (key) => typeof host[key as keyof PracticeOwnershipHttpHost] !== 'function',
    )
  )
    fail('STORAGE_CONTRACT');
  async function handle(request: Request, params: unknown, method: 'GET' | 'POST') {
    let requestId: string = crypto.randomUUID();
    try {
      const id = InternalId.safeParse(host.requestId());
      if (id.success) requestId = id.data;
    } catch {
      /* Diagnostics remain private. */
    }
    // Observe rejection immediately, including when origin/authentication fails first.
    const resolvedParams = Promise.resolve(params).then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const }),
    );
    try {
      if (method === 'POST') await host.origin(request);
      const actor = SkillTaxonomyActorSchema.safeParse(await host.actor());
      if (!actor.success) fail('STORAGE_CONTRACT');
      await host.rateLimit(actor.data);
      if (request.method !== method && !(method === 'GET' && request.method === 'HEAD'))
        return Response.json(
          {
            error: {
              code: 'METHOD_NOT_ALLOWED',
              message: 'Method not allowed.',
              retryable: false,
              requestId,
            },
          },
          { status: 405, headers: { ...practiceOwnershipPrivateHeaders, Allow: 'GET, POST' } },
        );
      const route = await resolvedParams;
      if (!route.ok) fail('STORAGE_UNAVAILABLE');
      const path = Params.safeParse(route.value);
      if (!path.success) fail('INVALID_INPUT');
      const query = new URL(request.url).searchParams;
      if (method === 'GET') {
        if (
          query.getAll('purpose').length !== 1 ||
          query.getAll('revision').length > 1 ||
          [...query.keys()].some((key) => !['purpose', 'revision'].includes(key))
        )
          fail('INVALID_INPUT');
        const revision = query.get('revision');
        if (revision !== null && !/^[1-9]\d{0,9}$/.test(revision)) fail('INVALID_INPUT');
        const input = ReadPracticeTrialOwnershipInputSchema.safeParse({
          version: 'v1',
          ...path.data,
          purpose: query.get('purpose'),
          ...(revision === null ? {} : { revision: Number(revision) }),
        });
        if (!input.success) fail('INVALID_INPUT');
        const result = PracticeOwnershipHttpReadResultSchema.safeParse(
          await host.read(actor.data, input.data),
        );
        if (!result.success) fail('STORAGE_CONTRACT');
        if (!result.data.readsAvailable) fail('STORAGE_UNAVAILABLE');
        const view = result.data.view;
        if (!view) fail('RESOURCE_UNAVAILABLE');
        if (
          view.record.reference.recordId !== input.data.submissionId ||
          (input.data.revision === undefined
            ? !view.isCurrent
            : view.record.reference.revision !== input.data.revision)
        )
          fail('STORAGE_CONTRACT');
        return Response.json(result.data, { headers: practiceOwnershipPrivateHeaders });
      }
      if (query.size !== 0) fail('INVALID_INPUT');
      const key = InternalId.safeParse(request.headers.get('Idempotency-Key'));
      if (!key.success) fail('INVALID_INPUT');
      const input = RecordPracticeTrialOwnershipInputSchema.safeParse(
        await readBoundedJson(request, { maximumBytes: 262144 }),
      );
      if (
        !input.success ||
        input.data.assignmentId !== path.data.assignmentId ||
        input.data.submissionId !== path.data.submissionId
      )
        fail('INVALID_INPUT');
      const result = PracticeOwnershipHttpWriteResultSchema.safeParse(
        await host.record({
          actor: actor.data,
          input: input.data,
          idempotencyKey: key.data,
          requestId,
        }),
      );
      if (!result.success) fail('STORAGE_CONTRACT');
      const view = result.data.view;
      if (view) {
        const record = view.record;
        if (
          record.assignmentId !== input.data.assignmentId ||
          record.evaluatorAccountId !== actor.data.accountId ||
          record.reference.recordId !== input.data.submissionId ||
          record.reference.revision !==
            (input.data.expectedOwnershipReference?.revision ?? 0) + 1 ||
          !same(record.submissionReference, input.data.expectedSubmissionReference) ||
          !same(record.definitionReference, input.data.expectedDefinitionReference) ||
          !same(record.rubricReference, input.data.expectedRubricReference) ||
          !same(record.policyReference, input.data.expectedPolicyReference) ||
          record.decision !== input.data.decision ||
          record.reason !== input.data.reason ||
          JSON.stringify(record.observations) !== JSON.stringify(input.data.observations) ||
          (result.data.status === 'EXECUTED' && !view.isCurrent)
        )
          fail('STORAGE_CONTRACT');
      }
      // A read gate closing after commit hides the body, not the successful command status.
      return Response.json(result.data, { headers: practiceOwnershipPrivateHeaders });
    } catch (error) {
      return failure(error, requestId);
    }
  }
  return {
    GET: (request: Request, params: unknown) => handle(request, params, 'GET'),
    POST: (request: Request, params: unknown) => handle(request, params, 'POST'),
  };
}
