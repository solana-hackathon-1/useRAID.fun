import { z } from 'zod';
import { ApplicationResultSchema, OfferResultSchema } from '../work-loop/admission-contracts';
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

/**
 * Portable browser view of the protected work HTTP boundary. It imports only zod and owned pure contracts, parses
 * every response with the server's strict schemas and keeps one idempotency key per user intent so an unconfirmed
 * request can be retried safely. The server, not this client, is the authority.
 */
export interface WorkTransport {
  request(
    method: 'GET' | 'POST',
    path: string,
    init?: { body?: unknown; idempotencyKey?: string },
  ): Promise<{ status: number; body: unknown }>;
}
export class WorkClientError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null,
    readonly requestId: string | null = null,
  ) {
    super(code);
    this.name = 'WorkClientError';
  }
}
export const fetchTransport: WorkTransport = {
  async request(method, path, init) {
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(init?.idempotencyKey ? { 'Idempotency-Key': init.idempotencyKey } : {}),
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {}
    return { status: response.status, body };
  },
};
export function newRequestKey() {
  return crypto.randomUUID();
}
const Envelope = z.object({
  error: z.object({ code: z.string(), requestId: z.string().optional() }),
});
export type MyRaidsView = z.output<typeof MyRaidsSchema>;
export type ReviewQueueView = z.output<typeof ReviewQueueSchema>;
export type ApplicantQueueView = z.output<typeof ApplicantQueueSchema>;
export type SubmitWorkRequest = z.input<typeof SubmitWorkInput>;
export type DecideReviewRequest = z.input<typeof DecideReviewInput>;
export function createWorkClient(transport: WorkTransport = fetchTransport) {
  async function call<T>(
    schema: z.ZodType<T>,
    method: 'GET' | 'POST',
    path: string,
    init?: { body?: unknown; idempotencyKey?: string },
  ): Promise<T> {
    const { status, body } = await transport.request(method, path, init);
    if (status >= 200 && status < 300) {
      const parsed = schema.safeParse(body);
      if (!parsed.success) throw new WorkClientError('CONTRACT', status);
      return parsed.data;
    }
    const envelope = Envelope.safeParse(body);
    throw envelope.success
      ? new WorkClientError(envelope.data.error.code, status, envelope.data.error.requestId ?? null)
      : new WorkClientError('CONTRACT', status);
  }
  const write = (body: unknown, idempotencyKey: string) => ({ body, idempotencyKey });
  return {
    me: () => call(MyRaidsSchema, 'GET', '/api/v1/work/me', undefined),
    reviews: () => call(ReviewQueueSchema, 'GET', '/api/v1/work/reviews', undefined),
    applicants: () => call(ApplicantQueueSchema, 'GET', '/api/v1/work/applicants', undefined),
    submitWork: (input: SubmitWorkRequest, key: string) =>
      call(SubmissionResultSchema, 'POST', '/api/v1/work/submissions', write(input, key)),
    decideReview: (input: DecideReviewRequest, key: string) =>
      call(ReviewResultSchema, 'POST', '/api/v1/work/reviews', write(input, key)),
    issueOffer: (input: { applicationId: string; expiresAt: string }, key: string) =>
      call(OfferResultSchema, 'POST', '/api/v1/work/offers', write(input, key)),
    revokeOffer: (offerId: string, key: string) =>
      call(
        OfferResultSchema,
        'POST',
        `/api/v1/work/offers/${encodeURIComponent(offerId)}/revocation`,
        write({}, key),
      ),
    submitApplication: (
      input: { slotId: string; termsVersionId: string; evidenceRefs: string[] },
      key: string,
    ) => call(ApplicationResultSchema, 'POST', '/api/v1/work/applications', write(input, key)),
    withdrawApplication: (applicationId: string, key: string) =>
      call(
        ApplicationResultSchema,
        'POST',
        `/api/v1/work/applications/${encodeURIComponent(applicationId)}/withdrawal`,
        write({}, key),
      ),
  };
}
export type FailureKind = 'RETRY_SAME_REQUEST' | 'REFRESH' | 'SIGN_IN' | 'NONE';
/** Short, safe guidance; server text and internal detail are never shown. */
export function describeWorkFailure(error: unknown): { kind: FailureKind; message: string } {
  if (error instanceof WorkClientError) {
    switch (error.code) {
      case 'AUTHENTICATION_REQUIRED':
        return { kind: 'SIGN_IN', message: 'Sign in again to continue.' };
      case 'REVISION_CHANGED':
      case 'OFFER_EXPIRED':
      case 'TERMS_VERSION_CHANGED':
      case 'SLOT_FILLED':
        return {
          kind: 'REFRESH',
          message: 'This changed while you were working. Refresh to see the current state.',
        };
      case 'RATE_LIMITED':
      case 'SERVICE_UNAVAILABLE':
        return {
          kind: 'RETRY_SAME_REQUEST',
          message: 'The request could not be completed. You can retry it safely.',
        };
      case 'FORBIDDEN':
      case 'ACCOUNT_RESTRICTED':
        return { kind: 'NONE', message: 'This action is not permitted for your account.' };
      case 'CAPACITY_CONFLICT':
        return { kind: 'NONE', message: 'You already have an active Raid, so this cannot start.' };
      case 'IDEMPOTENCY_KEY_REUSED':
        return {
          kind: 'NONE',
          message: 'That request key was already used. Reload and try again.',
        };
      case 'INVALID_COMMAND':
        return { kind: 'NONE', message: 'Check the form fields and try again.' };
      case 'NOT_FOUND':
        return { kind: 'NONE', message: 'That item was not found or is not yours.' };
      default:
        return { kind: 'NONE', message: 'The request was not accepted. Reload and try again.' };
    }
  }
  // A transport failure or unexpected throw leaves the result unconfirmed: retry with the same key.
  return {
    kind: 'RETRY_SAME_REQUEST',
    message: 'The result is unconfirmed. Retry with the same request to avoid a duplicate.',
  };
}
