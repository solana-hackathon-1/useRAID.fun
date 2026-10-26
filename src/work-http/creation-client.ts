import { z } from 'zod';
import {
  CreationStateSchema,
  PublishResultSchema,
  RecommendationSchema,
  SaveDraftResultSchema,
  type SaveDraftInput,
} from '../work-loop/creation-contracts';
import type { RecommendationInput } from '../work-loop/recommendation-contracts';
import { WorkClientError, fetchTransport, type WorkTransport } from './workspace-client';

export type CreationState = z.output<typeof CreationStateSchema>;
export type SaveDraftRequest = z.input<typeof SaveDraftInput>;
const Envelope = z.object({
  error: z.object({ code: z.string(), requestId: z.string().optional() }),
});
/**
 * Portable browser view of the creation boundary. Responses are parsed with the server's strict schemas, and the
 * caller keeps one idempotency key per unchanged intent so an unconfirmed save or publish can be retried safely.
 */
export function createCreationClient(transport: WorkTransport = fetchTransport) {
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
  return {
    state: () => call(CreationStateSchema, 'GET', '/api/v1/work/creation'),
    saveDraft: (input: SaveDraftRequest, idempotencyKey: string) =>
      call(SaveDraftResultSchema, 'POST', '/api/v1/work/drafts', { body: input, idempotencyKey }),
    publishDraft: (listingId: string, termsVersionId: string, idempotencyKey: string) =>
      call(
        PublishResultSchema,
        'POST',
        `/api/v1/work/drafts/${encodeURIComponent(listingId)}/publication`,
        { body: { termsVersionId }, idempotencyKey },
      ),
    recommend: (input: RecommendationInput) =>
      call(RecommendationSchema, 'POST', '/api/v1/work/recommendations', { body: input }),
  };
}
