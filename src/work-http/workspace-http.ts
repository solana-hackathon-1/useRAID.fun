import { z } from 'zod';
import { InternalId, UtcTimestamp } from '../contracts/ids';
import { createErrorEnvelope, type ErrorCode } from '../contracts/protocol';
import { readBoundedJson, JsonBodyFailure } from '../http-contracts/json';
import { CommandReceiptError } from '../command-receipts';
import { WorkError, type WorkCommand, type WorkActor } from '../work-loop/contracts';
import {
  ApplicationResultSchema,
  OfferResultSchema,
  SubmitApplicationInput,
} from '../work-loop/admission-contracts';
import {
  DecideReviewInput,
  ReviewResultSchema,
  SubmissionResultSchema,
  SubmitWorkInput,
} from '../work-loop/submission-contracts';
import {
  ApplicantQueueSchema,
  MyRaidsSchema,
  ReviewQueueSchema,
} from '../work-loop/workspace-contracts';

export class WorkHttpError extends Error {
  constructor(readonly status: 401 | 403 | 429) {
    super('HTTP_AUTHORITY_DENIED');
    this.name = 'WorkHttpError';
  }
}
/** Transport-neutral host: the host owns session, origin, rate limit, flags, SQL and command receipts. */
export interface WorkHttpHost {
  readonly version: 'v1';
  requestId(): string;
  actor(): Promise<WorkActor>;
  checkOrigin(request: Request): void | Promise<void>;
  rateLimit(actor: WorkActor): void | Promise<void>;
  me(actor: WorkActor): Promise<unknown>;
  reviews(actor: WorkActor): Promise<unknown>;
  applicants(actor: WorkActor): Promise<unknown>;
  submitWork(command: WorkCommand): Promise<unknown>;
  decideReview(command: WorkCommand): Promise<unknown>;
  issueOffer(command: WorkCommand): Promise<unknown>;
  revokeOffer(command: WorkCommand): Promise<unknown>;
  withdrawApplication(command: WorkCommand): Promise<unknown>;
  submitApplication(command: WorkCommand): Promise<unknown>;
}
export const workPrivateHeaders = Object.freeze({
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
});
const Actor = z.strictObject({
  accountId: InternalId,
  sessionHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const IssueOffer = z.strictObject({ applicationId: z.uuid(), expiresAt: UtcTimestamp });
const NoBody = z.strictObject({});
const CODES: Readonly<Record<string, ErrorCode>> = {
  INVALID_INPUT: 'INVALID_COMMAND',
  UNAUTHENTICATED: 'AUTHENTICATION_REQUIRED',
  ACCOUNT_RESTRICTED: 'ACCOUNT_RESTRICTED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  ELIGIBILITY_REJECTED: 'FORBIDDEN',
  CAPACITY_CONFLICT: 'CAPACITY_CONFLICT',
  SLOT_FILLED: 'SLOT_FILLED',
  TERMS_VERSION_CHANGED: 'TERMS_VERSION_CHANGED',
  FUNDING_REQUIRED: 'FUNDING_NOT_VERIFIED',
  OFFER_UNAVAILABLE: 'OFFER_EXPIRED',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  // State, round, deadline and duplicate conflicts all mean: refresh the current record.
  REVISION_CONFLICT: 'REVISION_CHANGED',
  ENGAGEMENT_STATE: 'REVISION_CHANGED',
  REVIEW_EXISTS: 'REVISION_CHANGED',
  REVISION_LIMIT: 'REVISION_CHANGED',
  DEADLINE_PASSED: 'REVISION_CHANGED',
  DEADLINE_NOT_REACHED: 'REVISION_CHANGED',
  APPLICATION_LIMIT: 'REVISION_CHANGED',
  APPLICATION_EXISTS: 'REVISION_CHANGED',
  APPLICATION_CLOSED: 'REVISION_CHANGED',
  OFFER_EXISTS: 'REVISION_CHANGED',
  PUBLICATION_BLOCKED: 'REVISION_CHANGED',
  TERMS_FROZEN: 'REVISION_CHANGED',
  ADMISSION_REQUIRED: 'APPROVAL_REQUIRED',
};
function invalid(): never {
  throw new JsonBodyFailure(422);
}
function contract(): never {
  throw new WorkError('STORAGE_CONTRACT');
}
function failure(e: unknown, id: string) {
  let code: ErrorCode = 'SERVICE_UNAVAILABLE',
    status: number | undefined;
  if (e instanceof JsonBodyFailure) {
    code = 'INVALID_COMMAND';
    status = e.status;
  } else if (e instanceof WorkHttpError)
    code =
      e.status === 401
        ? 'AUTHENTICATION_REQUIRED'
        : e.status === 403
          ? 'FORBIDDEN'
          : 'RATE_LIMITED';
  else if (e instanceof WorkError) code = CODES[e.code] ?? 'SERVICE_UNAVAILABLE';
  else if (e instanceof CommandReceiptError && e.code === 'IDEMPOTENCY_KEY_REUSED')
    code = 'IDEMPOTENCY_KEY_REUSED';
  const result = createErrorEnvelope(code, id);
  return Response.json(result.body, {
    status: status ?? result.status,
    headers: workPrivateHeaders,
  });
}
export { failure as workFailure, invalid as workInvalid, contract as workContract };
export function createWorkHandlers(host: WorkHttpHost) {
  if (
    host?.version !== 'v1' ||
    [
      'requestId',
      'actor',
      'checkOrigin',
      'rateLimit',
      'me',
      'reviews',
      'applicants',
      'submitWork',
      'decideReview',
      'issueOffer',
      'revokeOffer',
      'withdrawApplication',
      'submitApplication',
    ].some((k) => typeof host[k as keyof WorkHttpHost] !== 'function')
  )
    contract();
  function correlation() {
    try {
      const v = InternalId.safeParse(host.requestId());
      if (v.success) return v.data;
    } catch {}
    return crypto.randomUUID();
  }
  async function run(
    request: Request,
    write: boolean,
    work: (actor: WorkActor, requestId: string) => Promise<unknown>,
  ) {
    const id = correlation();
    try {
      if (write) await host.checkOrigin(request);
      const a = Actor.safeParse(await host.actor());
      if (!a.success) contract();
      await host.rateLimit(a.data);
      if (request.method !== (write ? 'POST' : 'GET'))
        return Response.json(
          {
            error: {
              code: 'METHOD_NOT_ALLOWED',
              message: 'Method not allowed.',
              retryable: false,
              requestId: id,
            },
          },
          { status: 405, headers: workPrivateHeaders },
        );
      if (new URL(request.url).searchParams.size) invalid();
      return Response.json(await work(a.data, id), { headers: workPrivateHeaders });
    } catch (e) {
      return failure(e, id);
    }
  }
  function key(request: Request) {
    const k = InternalId.safeParse(request.headers.get('idempotency-key'));
    if (!k.success) invalid();
    return k.data;
  }
  async function command<T>(
    request: Request,
    schema: z.ZodType<T>,
    actor: WorkActor,
    requestId: string,
    extra: Record<string, unknown> = {},
  ): Promise<WorkCommand & { input: T }> {
    const idempotencyKey = key(request);
    const parsed = schema.safeParse(await readBoundedJson(request, { maximumBytes: 65536 }));
    if (!parsed.success) invalid();
    return { actor, input: { ...parsed.data, ...extra } as T, idempotencyKey, requestId };
  }
  const read =
    <T>(schema: z.ZodType<T>, load: (a: WorkActor) => Promise<unknown>) =>
    (request: Request) =>
      run(request, false, async (a) => {
        const parsed = schema.safeParse(await load(a));
        if (!parsed.success) contract();
        return parsed.data;
      });
  const uuid = async (id: string | Promise<string>) => {
    const target = z.uuid().safeParse(await id);
    if (!target.success) invalid();
    return target.data;
  };
  return {
    ME: read(MyRaidsSchema, host.me),
    REVIEWS: read(ReviewQueueSchema, host.reviews),
    APPLICANTS: read(ApplicantQueueSchema, host.applicants),
    SUBMIT(request: Request) {
      return run(request, true, async (a, requestId) => {
        const c = await command(request, SubmitWorkInput, a, requestId);
        const r = SubmissionResultSchema.safeParse(await host.submitWork(c));
        if (!r.success || r.data.submission.engagementId !== c.input.engagementId) contract();
        return r.data;
      });
    },
    DECIDE(request: Request) {
      return run(request, true, async (a, requestId) => {
        const c = await command(request, DecideReviewInput, a, requestId);
        const r = ReviewResultSchema.safeParse(await host.decideReview(c));
        if (
          !r.success ||
          r.data.review.submissionId !== c.input.submissionId ||
          r.data.review.decision !== c.input.decision
        )
          contract();
        return r.data;
      });
    },
    ISSUE_OFFER(request: Request) {
      return run(request, true, async (a, requestId) => {
        const c = await command(request, IssueOffer, a, requestId);
        const r = OfferResultSchema.safeParse(await host.issueOffer(c));
        if (!r.success || r.data.offer.applicationId !== c.input.applicationId) contract();
        return r.data;
      });
    },
    REVOKE_OFFER(request: Request, offerId: string | Promise<string>) {
      return run(request, true, async (a, requestId) => {
        const target = await uuid(offerId);
        const c = await command(request, NoBody, a, requestId, { offerId: target });
        const r = OfferResultSchema.safeParse(await host.revokeOffer(c));
        if (!r.success || r.data.offer.id !== target) contract();
        return r.data;
      });
    },
    APPLY(request: Request) {
      return run(request, true, async (a, requestId) => {
        const c = await command(request, SubmitApplicationInput, a, requestId);
        const r = ApplicationResultSchema.safeParse(await host.submitApplication(c));
        if (
          !r.success ||
          r.data.application.slotId !== c.input.slotId ||
          r.data.application.termsVersionId !== c.input.termsVersionId
        )
          contract();
        return r.data;
      });
    },
    WITHDRAW(request: Request, applicationId: string | Promise<string>) {
      return run(request, true, async (a, requestId) => {
        const target = await uuid(applicationId);
        const c = await command(request, NoBody, a, requestId, { applicationId: target });
        const r = ApplicationResultSchema.safeParse(await host.withdrawApplication(c));
        if (!r.success || r.data.application.id !== target) contract();
        return r.data;
      });
    },
  };
}
