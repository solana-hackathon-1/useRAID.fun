import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import { readBoundedJson } from '../http-contracts/json';
import { type WorkActor, type WorkCommand } from '../work-loop/contracts';
import { CloseOverdueInput, CloseResultSchema } from '../work-loop/closure-contracts';
import { workContract, workFailure, workInvalid, workPrivateHeaders } from './workspace-http';

/** Transport-neutral host: the host owns session, origin, rate limit, flag, SQL, authority and command receipts. */
export interface ClosureHttpHost {
  readonly version: 'v1';
  requestId(): string;
  actor(): Promise<WorkActor>;
  checkOrigin(request: Request): void | Promise<void>;
  rateLimit(actor: WorkActor): void | Promise<void>;
  closeEngagement(command: WorkCommand): Promise<unknown>;
}
const Actor = z.strictObject({
  accountId: InternalId,
  sessionHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const Body = CloseOverdueInput.omit({ engagementId: true });
/**
 * `POST /api/v1/work/engagements/{id}/closure`: an authorized operator closes work whose accepted operational deadline
 * has passed. The server decides the reason from the engagement's state; the caller sends only the revision it read.
 */
export function createClosureHandlers(host: ClosureHttpHost) {
  if (
    host?.version !== 'v1' ||
    ['requestId', 'actor', 'checkOrigin', 'rateLimit', 'closeEngagement'].some(
      (k) => typeof host[k as keyof ClosureHttpHost] !== 'function',
    )
  )
    workContract();
  function correlation() {
    try {
      const v = InternalId.safeParse(host.requestId());
      if (v.success) return v.data;
    } catch {}
    return crypto.randomUUID();
  }
  return {
    async CLOSE(request: Request, engagementId: string | Promise<string>) {
      const id = correlation();
      try {
        await host.checkOrigin(request);
        const a = Actor.safeParse(await host.actor());
        if (!a.success) return workContract();
        await host.rateLimit(a.data);
        if (request.method !== 'POST')
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
        if (new URL(request.url).searchParams.size) return workInvalid();
        const target = z.uuid().safeParse(await engagementId);
        if (!target.success) return workInvalid();
        const key = InternalId.safeParse(request.headers.get('idempotency-key'));
        if (!key.success) return workInvalid();
        const body = Body.safeParse(await readBoundedJson(request, { maximumBytes: 4096 }));
        if (!body.success) return workInvalid();
        const input = { engagementId: target.data, ...body.data };
        const result = CloseResultSchema.safeParse(
          await host.closeEngagement({
            actor: a.data,
            input,
            idempotencyKey: key.data,
            requestId: id,
          }),
        );
        if (!result.success || result.data.closure.engagementId !== input.engagementId)
          return workContract();
        return Response.json(result.data, { headers: workPrivateHeaders });
      } catch (e) {
        return workFailure(e, id);
      }
    },
  };
}
