import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import { readBoundedJson } from '../http-contracts/json';
import { canonicalRequestDigest, CommandReceiptError } from '../command-receipts';
import type { WorkActor, WorkCommand } from '../work-loop/contracts';
import {
  AmendmentResultSchema,
  ProposeAmendmentInput,
  type Amendment,
} from '../work-loop/amendment-contracts';
import { AmendmentDeskSchema } from '../work-loop/amendment-desk-contracts';
import { workContract, workFailure, workInvalid, workPrivateHeaders } from './workspace-http';
import type { ErrorCode } from '../contracts/protocol';

/** Transport-neutral host: the host owns session, origin, rate limits, flag, SQL, authority and command receipts. */
export interface AmendmentHttpHost {
  readonly version: 'v1';
  requestId(): string;
  actor(): Promise<WorkActor>;
  checkOrigin(request: Request): void | Promise<void>;
  /** Reads and commands are throttled separately so a page refresh cannot spend the command allowance. */
  rateLimit(actor: WorkActor, kind: 'read' | 'command'): void | Promise<void>;
  desk(actor: WorkActor): Promise<unknown>;
  propose(command: WorkCommand): Promise<unknown>;
  /** `expectedDigest` is the exact proposal version the member says they read; null for a decline. */
  respond(command: WorkCommand, expectedDigest: string | null): Promise<unknown>;
  withdraw(command: WorkCommand): Promise<unknown>;
}
const Actor = z.strictObject({
  accountId: InternalId,
  sessionHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const Digest = z.string().regex(/^[0-9a-f]{64}$/);
const Response_ = z.discriminatedUnion('decision', [
  z.strictObject({ decision: z.literal('ACCEPT'), digest: Digest }),
  z.strictObject({ decision: z.literal('DECLINE') }),
]);
const NoBody = z.strictObject({});
/** A closed or decided proposal is "no longer open"; an existing open proposal means refresh the current record. */
const AMENDMENT_CODES: Readonly<Record<string, ErrorCode>> = {
  AMENDMENT_UNAVAILABLE: 'NO_LONGER_OPEN',
  AMENDMENT_EXISTS: 'REVISION_CHANGED',
};
const privateHeaders = workPrivateHeaders;
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
    { status: 405, headers: privateHeaders },
  );
/** The stored version must be self-consistent: its digest is the digest of exactly its terms. */
function intact(amendment: Amendment) {
  return canonicalRequestDigest(amendment.terms) === amendment.digest;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** The stored terms must carry exactly what the Founder asked to change. */
function carriesChanges(
  amendment: Amendment,
  changes: z.infer<typeof ProposeAmendmentInput>['changes'],
) {
  const terms = amendment.terms;
  if (changes.scope !== undefined && terms.scope !== changes.scope) return false;
  if (changes.acceptanceCriteria && !same(terms.acceptanceCriteria, changes.acceptanceCriteria))
    return false;
  if (
    changes.rewards &&
    !same(
      terms.rewards.map((leg) => leg.amount),
      changes.rewards.map((leg) => leg.amount),
    )
  )
    return false;
  for (const [key, value] of Object.entries(changes.deadlines ?? {}))
    if (value !== undefined && terms.deadlines[key as keyof typeof terms.deadlines] !== value)
      return false;
  return true;
}
export function createAmendmentHandlers(host: AmendmentHttpHost) {
  if (
    host?.version !== 'v1' ||
    [
      'requestId',
      'actor',
      'checkOrigin',
      'rateLimit',
      'desk',
      'propose',
      'respond',
      'withdraw',
    ].some((k) => typeof host[k as keyof AmendmentHttpHost] !== 'function')
  )
    workContract();
  function correlation() {
    try {
      const v = InternalId.safeParse(host.requestId());
      if (v.success) return v.data;
    } catch {}
    return crypto.randomUUID();
  }
  /** Origin first for commands, then the signed-in actor, then the per-client throttle; only then any parsing. */
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
      return Response.json(await work(a.data, id), { headers: privateHeaders });
    } catch (e) {
      return workFailure(e, id, AMENDMENT_CODES);
    }
  }
  function key(request: Request) {
    const k = InternalId.safeParse(request.headers.get('idempotency-key'));
    if (!k.success) workInvalid();
    return k.data;
  }
  async function body<T>(request: Request, schema: z.ZodType<T>) {
    const parsed = schema.safeParse(await readBoundedJson(request, { maximumBytes: 16384 }));
    if (!parsed.success) workInvalid();
    return parsed.data;
  }
  async function target(id: string | Promise<string>) {
    const parsed = z.uuid().safeParse(await id);
    if (!parsed.success) workInvalid();
    return parsed.data;
  }
  /** Re-parses the host result with the strict schema and requires it to describe this request. */
  function result(raw: unknown, matches: (amendment: Amendment) => boolean) {
    const parsed = AmendmentResultSchema.safeParse(raw);
    if (!parsed.success || !intact(parsed.data.amendment) || !matches(parsed.data.amendment))
      return workContract();
    return parsed.data;
  }
  return {
    DESK(request: Request) {
      return guarded(request, false, async (actor) => {
        const parsed = AmendmentDeskSchema.safeParse(await host.desk(actor));
        if (!parsed.success) return workContract();
        return parsed.data;
      });
    },
    PROPOSE(request: Request) {
      return guarded(request, true, async (actor, requestId) => {
        const idempotencyKey = key(request);
        const input = await body(request, ProposeAmendmentInput);
        // A replay may find the proposal accepted, declined or withdrawn since: any state is a valid recorded answer.
        return result(
          await host.propose({ actor, input, idempotencyKey, requestId }),
          (a) => a.engagementId === input.engagementId && carriesChanges(a, input.changes),
        );
      });
    },
    RESPOND(request: Request, amendmentId: string | Promise<string>) {
      return guarded(request, true, async (actor, requestId) => {
        const id = await target(amendmentId);
        const idempotencyKey = key(request);
        const decided = await body(request, Response_);
        const input = { amendmentId: id, decision: decided.decision };
        const expected = decided.decision === 'ACCEPT' ? decided.digest : null;
        // Decided proposals are terminal, so a replay reports the same state the first answer did.
        const raw = await host.respond({ actor, input, idempotencyKey, requestId }, expected);
        const state = decided.decision === 'ACCEPT' ? 'ACCEPTED' : 'DECLINED';
        // The same key replayed with another version's digest is a reused key, not a service fault; nothing is written.
        const recorded = AmendmentResultSchema.safeParse(raw);
        if (
          recorded.success &&
          intact(recorded.data.amendment) &&
          recorded.data.amendment.id === id &&
          recorded.data.amendment.state === state &&
          expected !== null &&
          recorded.data.amendment.digest !== expected
        )
          throw new CommandReceiptError('IDEMPOTENCY_KEY_REUSED');
        return result(
          raw,
          (a) => a.id === id && a.state === state && (expected === null || a.digest === expected),
        );
      });
    },
    WITHDRAW(request: Request, amendmentId: string | Promise<string>) {
      return guarded(request, true, async (actor, requestId) => {
        const id = await target(amendmentId);
        const idempotencyKey = key(request);
        await body(request, NoBody);
        return result(
          await host.withdraw({ actor, input: { amendmentId: id }, idempotencyKey, requestId }),
          (a) => a.id === id && a.state === 'WITHDRAWN',
        );
      });
    },
  };
}
