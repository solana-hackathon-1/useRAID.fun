import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import { readBoundedJson } from '../http-contracts/json';
import type { WorkActor } from '../work-loop/contracts';
import {
  workContract,
  workFailure,
  workInvalid,
  workPrivateHeaders,
} from '../work-http/workspace-http';
import {
  NotificationCursorSchema,
  NotificationStateSchema,
  PreferencesSchema,
  type NotificationState,
} from './contracts';

export { NotificationStateSchema, type NotificationState };
/** Transport-neutral host: it owns session, origin, rate limit, flags and SQL. Same authority contract as the work host. */
export interface NotificationsHttpHost {
  readonly version: 'v1';
  requestId(): string;
  actor(): Promise<WorkActor>;
  checkOrigin(request: Request): void | Promise<void>;
  rateLimit(actor: WorkActor): void | Promise<void>;
  /** `options.cursor` is passed only when the request carried one; a host that ignores it serves the first page. */
  state(actor: WorkActor, options?: { cursor?: string }): Promise<unknown>;
  markRead(actor: WorkActor, id: string): Promise<unknown>;
  setPreferences(actor: WorkActor, value: { promotional: boolean }): Promise<unknown>;
}
const Actor = z.strictObject({
  accountId: InternalId,
  sessionHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const NoBody = z.strictObject({});
export function createNotificationHandlers(host: NotificationsHttpHost) {
  if (
    host?.version !== 'v1' ||
    ['requestId', 'actor', 'checkOrigin', 'rateLimit', 'state', 'markRead', 'setPreferences'].some(
      (k) => typeof host[k as keyof NotificationsHttpHost] !== 'function',
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
  async function run(
    request: Request,
    write: boolean,
    work: (actor: WorkActor, query: URLSearchParams) => Promise<unknown>,
    allowCursor = false,
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
      const query = new URL(request.url).searchParams;
      // Only the list accepts one optional `cursor`; every other query is refused as before.
      if (query.size && !(allowCursor && query.size === 1 && query.getAll('cursor').length === 1))
        workInvalid();
      return Response.json(await work(a.data!, query), { headers: workPrivateHeaders });
    } catch (e) {
      return workFailure(e, id);
    }
  }
  return {
    STATE: (request: Request) =>
      run(
        request,
        false,
        async (a, query) => {
          const cursor = query.get('cursor');
          if (cursor !== null && !NotificationCursorSchema.safeParse(cursor).success) workInvalid();
          const parsed = NotificationStateSchema.safeParse(
            await (cursor === null ? host.state(a) : host.state(a, { cursor })),
          );
          if (!parsed.success) workContract();
          return parsed.data;
        },
        true,
      ),
    READ: (request: Request, notificationId: string | Promise<string>) =>
      run(request, true, async (a) => {
        const target = z.uuid().safeParse(await notificationId);
        if (!target.success) workInvalid();
        if (!NoBody.safeParse(await readBoundedJson(request, { maximumBytes: 1024 })).success)
          workInvalid();
        const result = z
          .strictObject({ id: z.uuid(), read: z.literal(true) })
          .safeParse(await host.markRead(a, target.data!));
        if (!result.success || result.data.id !== target.data) workContract();
        return result.data;
      }),
    PREFERENCES: (request: Request) =>
      run(request, true, async (a) => {
        const parsed = PreferencesSchema.safeParse(
          await readBoundedJson(request, { maximumBytes: 1024 }),
        );
        if (!parsed.success) workInvalid();
        const result = PreferencesSchema.safeParse(await host.setPreferences(a, parsed.data!));
        if (!result.success || result.data.promotional !== parsed.data!.promotional) workContract();
        return result.data;
      }),
  };
}
