import { z } from 'zod';
import { AmendmentResultSchema } from '../work-loop/amendment-contracts';
import { AmendmentDeskSchema } from '../work-loop/amendment-desk-contracts';
import {
  WorkClientError,
  describeWorkFailure,
  fetchTransport,
  type FailureKind,
  type WorkTransport,
} from './workspace-client';

/**
 * Portable browser view of the amendment HTTP boundary: it parses every response with the server's strict schemas and
 * leaves one idempotency key per user intent to the caller. The server, not this client, is the authority.
 */
const Envelope = z.object({
  error: z.object({ code: z.string(), requestId: z.string().optional() }),
});
export type AmendmentDeskView = z.output<typeof AmendmentDeskSchema>;
export type AmendmentView = z.output<typeof AmendmentResultSchema>['amendment'];
export interface ProposeRequest {
  engagementId: string;
  changes: {
    scope?: string;
    acceptanceCriteria?: string[];
    rewards?: { amount: string }[];
    deadlines?: Partial<
      Record<'preparation' | 'submission' | 'review' | 'operationalClosure', string>
    >;
  };
  expiresAt: string;
}
export function createAmendmentClient(transport: WorkTransport = fetchTransport) {
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
  const path = (id: string, leaf: string) =>
    `/api/v1/work/amendments/${encodeURIComponent(id)}/${leaf}`;
  return {
    desk: () => call(AmendmentDeskSchema, 'GET', '/api/v1/work/amendments'),
    propose: (input: ProposeRequest, key: string) =>
      call(AmendmentResultSchema, 'POST', '/api/v1/work/amendments', write(input, key)),
    accept: (id: string, digest: string, key: string) =>
      call(
        AmendmentResultSchema,
        'POST',
        path(id, 'response'),
        write({ decision: 'ACCEPT', digest }, key),
      ),
    decline: (id: string, key: string) =>
      call(
        AmendmentResultSchema,
        'POST',
        path(id, 'response'),
        write({ decision: 'DECLINE' }, key),
      ),
    withdraw: (id: string, key: string) =>
      call(AmendmentResultSchema, 'POST', path(id, 'withdrawal'), write({}, key)),
  };
}
export type AmendmentClient = ReturnType<typeof createAmendmentClient>;
/** Short, safe guidance for the amendment boundary; server text and internal detail are never shown. */
export function describeAmendmentFailure(error: unknown): { kind: FailureKind; message: string } {
  if (error instanceof WorkClientError) {
    switch (error.code) {
      case 'NO_LONGER_OPEN':
        return {
          kind: 'REFRESH',
          message:
            'This proposal is no longer open: it was already answered, withdrawn or has expired. Nothing changed.',
        };
      case 'REVISION_CHANGED':
        return {
          kind: 'REFRESH',
          message:
            'This changed while you were working (the work moved on, or another proposal is already open). Refresh to see the current state.',
        };
      case 'CONSENT_REQUIRED':
        return {
          kind: 'REFRESH',
          message:
            'Your agreement could not be recorded for exactly these terms. Refresh and review the current proposal.',
        };
      case 'FUNDING_NOT_VERIFIED':
        return {
          kind: 'NONE',
          message:
            'The added reward is not covered by the simulated funding, so nothing was proposed. No money has moved.',
        };
      case 'NOT_AVAILABLE':
        return {
          kind: 'NONE',
          message: 'Changing accepted terms is not open right now. Nothing was saved.',
        };
      case 'FORBIDDEN':
        return {
          kind: 'NONE',
          message: 'You are not permitted to do this for this work.',
        };
      case 'NOT_FOUND':
        return { kind: 'NONE', message: 'That proposal was not found or is not yours.' };
      default:
        return describeWorkFailure(error);
    }
  }
  return describeWorkFailure(error);
}
