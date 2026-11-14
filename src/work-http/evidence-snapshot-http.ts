import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import { readBoundedJson } from '../http-contracts/json';
import type { WorkActor, WorkCommand } from '../work-loop/contracts';
import {
  EvidenceSnapshotResultSchema,
  EvidenceSnapshotViewSchema,
  EvidenceSnapshotWithdrawalResultSchema,
  RecordEvidenceSnapshotBody,
} from '../work-loop/evidence-snapshot-contracts';
import { workContract, workFailure, workInvalid, workPrivateHeaders } from './workspace-http';

/** Transport-neutral host: the host owns session, origin, rate limits, flag, SQL, authority and command receipts. */
export interface EvidenceSnapshotHttpHost {
  readonly version: 'v1';
  requestId(): string;
  actor(): Promise<WorkActor>;
  checkOrigin(request: Request): void | Promise<void>;
  rateLimit(actor: WorkActor, kind: 'read' | 'command'): void | Promise<void>;
  view(actor: WorkActor, applicationId: string): Promise<unknown>;
  record(command: WorkCommand): Promise<unknown>;
  withdraw(command: WorkCommand): Promise<unknown>;
}
const Actor = z.strictObject({
  accountId: InternalId,
  sessionHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const NoBody = z.strictObject({});
const methodNotAllowed = (id: string) =>
  Response.json(
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
export function createEvidenceSnapshotHandlers(host: EvidenceSnapshotHttpHost) {
  if (
    host?.version !== 'v1' ||
    ['requestId', 'actor', 'checkOrigin', 'rateLimit', 'view', 'record', 'withdraw'].some(
      (k) => typeof host[k as keyof EvidenceSnapshotHttpHost] !== 'function',
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
  /** Origin first for commands, then the signed-in actor, then the throttle; only then any parsing. */
  async function guarded(
    request: Request,
    write: boolean,
    work: (actor: WorkActor, requestId: string) => Promise<unknown>,
  ) {
    const id = correlation();
    try {
      if (write) await host.checkOrigin(request);
      const a = Actor.safeParse(await host.actor());
      if (!a.success) return workContract();
      await host.rateLimit(a.data, write ? 'command' : 'read');
      if (request.method !== (write ? 'POST' : 'GET')) return methodNotAllowed(id);
      if (new URL(request.url).searchParams.size) return workInvalid();
      return Response.json(await work(a.data, id), { headers: workPrivateHeaders });
    } catch (e) {
      return workFailure(e, id);
    }
  }
  const key = (request: Request) => {
    const k = InternalId.safeParse(request.headers.get('idempotency-key'));
    if (!k.success) workInvalid();
    return k.data;
  };
  async function body<T>(request: Request, schema: z.ZodType<T>) {
    const parsed = schema.safeParse(await readBoundedJson(request, { maximumBytes: 8192 }));
    if (!parsed.success) workInvalid();
    return parsed.data;
  }
  async function target(id: string | Promise<string>) {
    const parsed = z.uuid().safeParse(await id);
    if (!parsed.success) workInvalid();
    return parsed.data;
  }
  /** Re-parses a host result with its strict schema and requires it to describe this request. */
  function echoed<T>(schema: z.ZodType<T>, raw: unknown, matches: (value: T) => boolean) {
    const parsed = schema.safeParse(raw);
    if (!parsed.success || !matches(parsed.data)) return workContract();
    return parsed.data;
  }
  return {
    VIEW(request: Request, applicationId: string | Promise<string>) {
      return guarded(request, false, async (actor) => {
        const id = await target(applicationId);
        return echoed(
          EvidenceSnapshotViewSchema,
          await host.view(actor, id),
          (v) => v.applicationId === id,
        );
      });
    },
    RECORD(request: Request, applicationId: string | Promise<string>) {
      return guarded(request, true, async (actor, requestId) => {
        const id = await target(applicationId);
        const idempotencyKey = key(request);
        const input = { applicationId: id, ...(await body(request, RecordEvidenceSnapshotBody)) };
        return echoed(
          EvidenceSnapshotResultSchema,
          await host.record({ actor, input, idempotencyKey, requestId }),
          (r) =>
            r.snapshot.applicationId === id &&
            r.snapshot.skills.map((s) => s.skillId).join('\n') === input.sharedSkillIds.join('\n'),
        );
      });
    },
    WITHDRAW(request: Request, applicationId: string | Promise<string>) {
      return guarded(request, true, async (actor, requestId) => {
        const id = await target(applicationId);
        const idempotencyKey = key(request);
        await body(request, NoBody);
        return echoed(
          EvidenceSnapshotWithdrawalResultSchema,
          await host.withdraw({ actor, input: { applicationId: id }, idempotencyKey, requestId }),
          (r) => r.applicationId === id,
        );
      });
    },
  };
}
