import {
  PracticeAssessmentReviewReadResultSchema,
  PracticeAssessmentStateReadResultSchema,
  PracticeAssessmentDecisionReadResultSchema,
  parsePracticeAssessmentReviewWriteResult,
  parsePracticeAssessmentDecisionWriteResult,
} from './practice-assessment-results';
export * from './practice-assessment-results';
import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import { createErrorEnvelope, type ErrorCode } from '../contracts/protocol';
import { CommandReceiptError } from '../command-receipts';
import { readBoundedJson, JsonBodyFailure } from '../http-contracts/json';
import { SkillTaxonomyActorSchema, type SkillTaxonomyActor } from './taxonomy-storage-contracts';
import {
  ReadPracticeTrialAssessmentInputSchema,
  RecordPracticeTrialAssessmentInputSchema,
  RecordPracticeAssessmentDecisionInputSchema,
  PracticeTrialAssessmentError,
  type PracticeTrialAssessmentCommand,
} from './practice-trial-assessment-storage';

export class PracticeAssessmentHttpError extends Error {
  constructor(readonly status: 401 | 403 | 429) {
    super('HTTP_AUTHORITY_DENIED');
    this.name = 'PracticeAssessmentHttpError';
  }
}
export interface PracticeAssessmentHttpHost {
  readonly version: 'v1';
  requestId(): string;
  origin(request: Request): void | Promise<void>;
  actor(): Promise<SkillTaxonomyActor>;
  rateLimit(actor: SkillTaxonomyActor): void | Promise<void>;
  readReview(actor: SkillTaxonomyActor, input: unknown): Promise<unknown>;
  recordReview(command: PracticeTrialAssessmentCommand): Promise<unknown>;
  readState(actor: SkillTaxonomyActor, input: unknown): Promise<unknown>;
  readDecision(actor: SkillTaxonomyActor, input: unknown): Promise<unknown>;
  recordDecision(command: PracticeTrialAssessmentCommand): Promise<unknown>;
}
export const practiceAssessmentPrivateHeaders = Object.freeze({
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
});
const Params = z.strictObject({ assignmentId: z.uuid(), submissionId: z.uuid() });
function fail(code: PracticeTrialAssessmentError['code']): never {
  throw new PracticeTrialAssessmentError(code);
}
function failure(error: unknown, requestId: string) {
  let code: ErrorCode = 'SERVICE_UNAVAILABLE';
  if (error instanceof PracticeAssessmentHttpError)
    code =
      error.status === 401
        ? 'AUTHENTICATION_REQUIRED'
        : error.status === 403
          ? 'FORBIDDEN'
          : 'RATE_LIMITED';
  else if (error instanceof JsonBodyFailure) code = 'INVALID_COMMAND';
  else if (error instanceof CommandReceiptError && error.code === 'IDEMPOTENCY_KEY_REUSED')
    code = error.code;
  else if (error instanceof PracticeTrialAssessmentError) {
    switch (error.code) {
      case 'AUTHENTICATION_REQUIRED':
      case 'ACCOUNT_RESTRICTED':
      case 'REVISION_CHANGED':
      case 'FAMILY_CHANGED':
      case 'EVIDENCE_NOT_CONFIRMED':
      case 'RUBRIC_NOT_MET':
      case 'HIGH_RANK_EVIDENCE_REQUIRED':
      case 'AUTOMATED_EVIDENCE_UNAVAILABLE':
      case 'TOOLS_POLICY_NOT_MET':
      case 'CURRENT_HIGHER_ASSESSMENT':
        code = error.code;
        break;
      case 'INVALID_INPUT':
        code = 'INVALID_COMMAND';
        break;
      case 'RESOURCE_UNAVAILABLE':
        code = 'NOT_FOUND';
        break;
    }
  }
  const result = createErrorEnvelope(code, requestId);
  return Response.json(result.body, {
    status: error instanceof JsonBodyFailure ? error.status : result.status,
    headers: practiceAssessmentPrivateHeaders,
  });
}
type Kind = 'review' | 'state' | 'decisions';
/** Host commits the canonical scoped command/read transaction before resolving a port. */
export function createPracticeAssessmentHandlers(host: PracticeAssessmentHttpHost) {
  if (
    host?.version !== 'v1' ||
    [
      'requestId',
      'origin',
      'actor',
      'rateLimit',
      'readReview',
      'recordReview',
      'readState',
      'readDecision',
      'recordDecision',
    ].some((key) => typeof host[key as keyof PracticeAssessmentHttpHost] !== 'function')
  )
    fail('STORAGE_CONTRACT');
  async function handle(kind: Kind, request: Request, params: unknown, method: 'GET' | 'POST') {
    let requestId: string = crypto.randomUUID();
    try {
      const id = InternalId.safeParse(host.requestId());
      if (id.success) requestId = id.data;
    } catch {
      /* No private diagnostics. */
    }
    // Observe path rejection immediately, even if origin or authentication fails first.
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
          {
            status: 405,
            headers: {
              ...practiceAssessmentPrivateHeaders,
              Allow: kind === 'state' ? 'GET, HEAD' : 'GET, HEAD, POST',
            },
          },
        );
      const resolved = await resolvedParams;
      if (!resolved.ok) fail('STORAGE_UNAVAILABLE');
      const path = Params.safeParse(resolved.value);
      if (!path.success) fail('INVALID_INPUT');
      const query = new URL(request.url).searchParams;
      if (method === 'GET') {
        if (
          query.getAll('revision').length > 1 ||
          [...query.keys()].some((key) => key !== 'revision')
        )
          fail('INVALID_INPUT');
        const revision = query.get('revision');
        if (revision !== null && !/^[1-9]\d{0,9}$/.test(revision)) fail('INVALID_INPUT');
        const input = ReadPracticeTrialAssessmentInputSchema.safeParse({
          version: 'v1',
          ...path.data,
          ...(revision === null ? {} : { revision: Number(revision) }),
        });
        if (!input.success) fail('INVALID_INPUT');
        const raw = await (
          kind === 'review'
            ? host.readReview
            : kind === 'state'
              ? host.readState
              : host.readDecision
        )(actor.data, input.data);
        if (kind === 'review') {
          const r = PracticeAssessmentReviewReadResultSchema.safeParse(raw);
          if (!r.success || !r.data.readsAvailable) fail('STORAGE_UNAVAILABLE');
          const v = r.data.view;
          if (!v) fail('RESOURCE_UNAVAILABLE');
          if (
            v.review.submissionReference.recordId !== input.data.submissionId ||
            (input.data.revision === undefined
              ? !v.isCurrentReview
              : v.review.reference.revision !== input.data.revision)
          )
            fail('STORAGE_CONTRACT');
          return Response.json(r.data, { headers: practiceAssessmentPrivateHeaders });
        }
        if (kind === 'state') {
          const r = PracticeAssessmentStateReadResultSchema.safeParse(raw);
          if (!r.success || !r.data.readsAvailable) fail('STORAGE_UNAVAILABLE');
          const v = r.data.view;
          if (!v) fail('RESOURCE_UNAVAILABLE');
          if (
            v.assessment.submissionReference.recordId !== input.data.submissionId ||
            (input.data.revision === undefined
              ? !v.isCurrent
              : v.assessment.reference.revision !== input.data.revision)
          )
            fail('STORAGE_CONTRACT');
          return Response.json(r.data, { headers: practiceAssessmentPrivateHeaders });
        }
        const r = PracticeAssessmentDecisionReadResultSchema.safeParse(raw);
        if (!r.success || !r.data.readsAvailable) fail('STORAGE_UNAVAILABLE');
        const v = r.data.view;
        if (!v) fail('RESOURCE_UNAVAILABLE');
        if (
          v.decision.submissionReference.recordId !== input.data.submissionId ||
          (input.data.revision === undefined
            ? !v.isCurrent
            : v.assessment.reference.revision !== input.data.revision)
        )
          fail('STORAGE_CONTRACT');
        return Response.json(r.data, { headers: practiceAssessmentPrivateHeaders });
      }
      if (query.size !== 0) fail('INVALID_INPUT');
      const key = InternalId.safeParse(request.headers.get('Idempotency-Key'));
      if (!key.success) fail('INVALID_INPUT');
      const body = await readBoundedJson(request, { maximumBytes: 262144 });
      if (kind === 'review') {
        const input = RecordPracticeTrialAssessmentInputSchema.safeParse(body);
        if (
          !input.success ||
          input.data.assignmentId !== path.data.assignmentId ||
          input.data.submissionId !== path.data.submissionId
        )
          fail('INVALID_INPUT');
        return Response.json(
          parsePracticeAssessmentReviewWriteResult(
            await host.recordReview({
              actor: actor.data,
              input: input.data,
              idempotencyKey: key.data,
              requestId,
            }),
            input.data,
            actor.data.accountId,
          ),
          { headers: practiceAssessmentPrivateHeaders },
        );
      }
      const input = RecordPracticeAssessmentDecisionInputSchema.safeParse(body);
      if (
        !input.success ||
        input.data.assignmentId !== path.data.assignmentId ||
        input.data.submissionId !== path.data.submissionId
      )
        fail('INVALID_INPUT');
      return Response.json(
        parsePracticeAssessmentDecisionWriteResult(
          await host.recordDecision({
            actor: actor.data,
            input: input.data,
            idempotencyKey: key.data,
            requestId,
          }),
          input.data,
          actor.data.accountId,
        ),
        { headers: practiceAssessmentPrivateHeaders },
      );
    } catch (error) {
      return failure(error, requestId);
    }
  }
  return {
    review: {
      GET: (r: Request, p: unknown) => handle('review', r, p, 'GET'),
      POST: (r: Request, p: unknown) => handle('review', r, p, 'POST'),
    },
    state: { GET: (r: Request, p: unknown) => handle('state', r, p, 'GET') },
    decisions: {
      GET: (r: Request, p: unknown) => handle('decisions', r, p, 'GET'),
      POST: (r: Request, p: unknown) => handle('decisions', r, p, 'POST'),
    },
  };
}
