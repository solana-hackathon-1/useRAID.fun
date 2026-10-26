import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import { readBoundedJson } from '../http-contracts/json';
import { canonicalRequestDigest } from '../command-receipts';
import type { WorkActor, WorkCommand } from '../work-loop/contracts';
import {
  CreationStateSchema,
  PublishDraftInput,
  PublishResultSchema,
  RecommendationInputSchema,
  RecommendationSchema,
  SaveDraftInput,
  SaveDraftResultSchema,
} from '../work-loop/creation-contracts';
import { workContract, workFailure, workInvalid, workPrivateHeaders } from './workspace-http';

/** Transport-neutral host for the Founder creation wizard. Same authority contract as the work workspace host. */
export interface CreationHttpHost {
  readonly version: 'v1';
  requestId(): string;
  actor(): Promise<WorkActor>;
  checkOrigin(request: Request): void | Promise<void>;
  rateLimit(actor: WorkActor): void | Promise<void>;
  state(actor: WorkActor): Promise<unknown>;
  saveDraft(command: WorkCommand): Promise<unknown>;
  publishDraft(command: WorkCommand): Promise<unknown>;
  recommend(actor: WorkActor, input: unknown): Promise<unknown>;
}
const Actor = z.strictObject({
  accountId: InternalId,
  sessionHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export function createCreationHandlers(host: CreationHttpHost) {
  if (
    host?.version !== 'v1' ||
    [
      'requestId',
      'actor',
      'checkOrigin',
      'rateLimit',
      'state',
      'saveDraft',
      'publishDraft',
      'recommend',
    ].some((k) => typeof host[k as keyof CreationHttpHost] !== 'function')
  )
    workContract();
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
      if (!a.success) workContract();
      await host.rateLimit(a.data!);
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
      if (new URL(request.url).searchParams.size) workInvalid();
      return Response.json(await work(a.data!, id), { headers: workPrivateHeaders });
    } catch (e) {
      return workFailure(e, id);
    }
  }
  async function body<T>(request: Request, schema: z.ZodType<T>) {
    const parsed = schema.safeParse(await readBoundedJson(request, { maximumBytes: 131072 }));
    if (!parsed.success) workInvalid();
    return parsed.data as T;
  }
  function key(request: Request) {
    const k = InternalId.safeParse(request.headers.get('idempotency-key'));
    if (!k.success) workInvalid();
    return k.data as string;
  }
  return {
    STATE: (request: Request) =>
      run(request, false, async (a) => {
        const parsed = CreationStateSchema.safeParse(await host.state(a));
        if (!parsed.success) workContract();
        return parsed.data;
      }),
    SAVE: (request: Request) =>
      run(request, true, async (a, requestId) => {
        const idempotencyKey = key(request);
        const input = await body(request, SaveDraftInput);
        const result = SaveDraftResultSchema.safeParse(
          await host.saveDraft({ actor: a, input, idempotencyKey, requestId }),
        );
        // The saved draft must be the exact terms that were sent, never a host-altered substitute.
        if (
          !result.success ||
          canonicalRequestDigest(result.data.draft.terms) !== canonicalRequestDigest(input.terms)
        )
          workContract();
        return result.data;
      }),
    PUBLISH: (request: Request, listingId: string | Promise<string>) =>
      run(request, true, async (a, requestId) => {
        const target = z.uuid().safeParse(await listingId);
        if (!target.success) workInvalid();
        const idempotencyKey = key(request);
        const input = { ...(await body(request, PublishDraftInput)), listingId: target.data! };
        const result = PublishResultSchema.safeParse(
          await host.publishDraft({ actor: a, input, idempotencyKey, requestId }),
        );
        if (
          !result.success ||
          result.data.listingId !== input.listingId ||
          result.data.termsVersionId !== input.termsVersionId
        )
          workContract();
        return result.data;
      }),
    RECOMMEND: (request: Request) =>
      run(request, true, async (a) => {
        const input = await body(request, RecommendationInputSchema);
        const result = RecommendationSchema.safeParse(await host.recommend(a, input));
        if (!result.success) workContract();
        return result.data;
      }),
  };
}
