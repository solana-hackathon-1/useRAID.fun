import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import { createErrorEnvelope, type ErrorCode } from '../contracts/protocol';
import { canonicalRequestDigest, CommandReceiptError } from '../command-receipts';
import { JsonBodyFailure, readBoundedJson } from '../http-contracts/json';
import { WorkError, type WorkActor, type WorkCommand } from '../work-loop/contracts';
import {
  CreatePartyInput,
  CreatePartyResultSchema,
  PartyProposalSchema,
  ProposePartyRosterInput,
  ProposePartyRosterResultSchema,
  RecordPartyConsentInput,
  RecordPartyConsentResultSchema,
  type PartyProposal,
} from './contracts';

/** Thrown by a host's origin, session or throttle adapter; the transport maps it to 401, 403 or 429. */
export class PartyHttpError extends Error {
  constructor(readonly status: 401 | 403 | 429) {
    super('HTTP_AUTHORITY_DENIED');
    this.name = 'PartyHttpError';
  }
}
/**
 * Transport-neutral host. The host owns the session (cookie to actor), origin policy, per-client throttles, the
 * default-off write switch, SQL and command receipts. Authority never comes from the request body: a member is the
 * signed-in session, a Party's leader is its creator, and the transport only parses, binds path ids and verifies
 * that every result describes the request that was made.
 */
export interface PartyHttpHost {
  readonly version: 'v1';
  requestId(): string;
  actor(): Promise<WorkActor>;
  checkOrigin(request: Request): void | Promise<void>;
  /** Reads and commands are throttled separately, so polling can never block a consent. */
  rateLimit(actor: WorkActor, scope: 'READ' | 'WRITE'): void | Promise<void>;
  create(command: WorkCommand): Promise<unknown>;
  propose(command: WorkCommand): Promise<unknown>;
  consent(command: WorkCommand): Promise<unknown>;
  read(actor: WorkActor, proposalId: string): Promise<unknown>;
}
export const partyHeaders = Object.freeze({
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
});
const MAX_BODY_BYTES = 65536;
const Actor = z.strictObject({
  accountId: InternalId,
  sessionHash: z.string().regex(/^[a-f0-9]{64}$/),
});
/** Ids come from the path, never the body, and are lowercased like the storage contracts so the digest is stable. */
const PathId = z.uuid().transform((value) => value.toLowerCase());
const ProposeBody = ProposePartyRosterInput.omit({ partyId: true });
const ConsentBody = RecordPartyConsentInput.omit({ proposalId: true });

// Keyed by every storage code, so a new code is a compile error here instead of a silent 503.
const STORAGE_CODES: Readonly<Record<WorkError['code'], ErrorCode>> = {
  UNAUTHENTICATED: 'AUTHENTICATION_REQUIRED',
  ACCOUNT_RESTRICTED: 'ACCOUNT_RESTRICTED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  INVALID_INPUT: 'INVALID_COMMAND',
  // A closed feature is a settled answer, not an outage worth retrying.
  WRITES_DISABLED: 'NOT_AVAILABLE',
  // Refresh the proposal: the digest the member saw is not the one stored.
  REVISION_CONFLICT: 'REVISION_CHANGED',
  SLOT_FILLED: 'SLOT_FILLED',
  TERMS_VERSION_CHANGED: 'TERMS_VERSION_CHANGED',
  // The slot, listing or commitment window closed under the Party; refreshing the record cannot reopen it.
  PUBLICATION_BLOCKED: 'NO_LONGER_OPEN',
  DEADLINE_PASSED: 'NO_LONGER_OPEN',
  // Not reachable from these routes (no admission, start, review, amendment or funding here); a leak is a 503.
  ENGAGEMENT_STATE: 'SERVICE_UNAVAILABLE',
  DEADLINE_NOT_REACHED: 'SERVICE_UNAVAILABLE',
  REVISION_LIMIT: 'SERVICE_UNAVAILABLE',
  REVIEW_EXISTS: 'SERVICE_UNAVAILABLE',
  APPLICATION_LIMIT: 'SERVICE_UNAVAILABLE',
  APPLICATION_EXISTS: 'SERVICE_UNAVAILABLE',
  APPLICATION_CLOSED: 'SERVICE_UNAVAILABLE',
  OFFER_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  OFFER_EXPIRED: 'SERVICE_UNAVAILABLE',
  RESOURCES_NOT_READY: 'SERVICE_UNAVAILABLE',
  OFFER_EXISTS: 'SERVICE_UNAVAILABLE',
  ELIGIBILITY_REJECTED: 'SERVICE_UNAVAILABLE',
  CAPACITY_CONFLICT: 'SERVICE_UNAVAILABLE',
  ADMISSION_REQUIRED: 'SERVICE_UNAVAILABLE',
  TERMS_FROZEN: 'SERVICE_UNAVAILABLE',
  FUNDING_REQUIRED: 'SERVICE_UNAVAILABLE',
  AMENDMENT_EXISTS: 'SERVICE_UNAVAILABLE',
  AMENDMENT_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  CONSENT_REQUIRED: 'SERVICE_UNAVAILABLE',
  REPLACEMENT_EXISTS: 'SERVICE_UNAVAILABLE',
  STORAGE_CONTRACT: 'SERVICE_UNAVAILABLE',
};
function failure(error: unknown, requestId: string) {
  let code: ErrorCode = 'SERVICE_UNAVAILABLE',
    status: number | undefined;
  if (error instanceof JsonBodyFailure) {
    code = 'INVALID_COMMAND';
    status = error.status;
  } else if (error instanceof PartyHttpError) {
    code =
      error.status === 401
        ? 'AUTHENTICATION_REQUIRED'
        : error.status === 403
          ? 'FORBIDDEN'
          : 'RATE_LIMITED';
  } else if (error instanceof WorkError) {
    code = STORAGE_CODES[error.code] ?? 'SERVICE_UNAVAILABLE';
  } else if (error instanceof CommandReceiptError && error.code === 'IDEMPOTENCY_KEY_REUSED') {
    code = 'IDEMPOTENCY_KEY_REUSED';
  }
  const result = createErrorEnvelope(code, requestId);
  return Response.json(result.body, { status: status ?? result.status, headers: partyHeaders });
}
const invalid = (): never => {
  throw new JsonBodyFailure(422);
};
const contract = (): never => {
  throw new WorkError('STORAGE_CONTRACT');
};
const byParticipant = <T extends { participantId: string }>(members: readonly T[]) =>
  [...members].sort((a, b) =>
    a.participantId < b.participantId ? -1 : a.participantId > b.participantId ? 1 : 0,
  );
/** The digest every member consents to: the same canonical form the storage hashes when it stores the snapshot. */
function rosterDigest(
  value: Pick<PartyProposal, 'partyId' | 'slotId' | 'termsVersionId' | 'termsDigest'>,
  members: readonly { participantId: string; role: string; allocations: { amount: string }[] }[],
) {
  return canonicalRequestDigest({
    partyId: value.partyId,
    slotId: value.slotId,
    termsVersionId: value.termsVersionId,
    termsDigest: value.termsDigest,
    members: byParticipant(members).map((m) => ({
      participantId: m.participantId,
      role: m.role,
      allocations: m.allocations.map((a) => ({ amount: a.amount })),
    })),
  });
}
/**
 * A proposal must be internally consistent, whatever the host's storage says: its digest binds the exact roster and
 * splits it shows, and `allConsented` follows the per-member consent state. Consent state itself is not part of the
 * request, so a replay after members consented is accepted.
 */
function verifiedProposal(raw: unknown): PartyProposal {
  const parsed = PartyProposalSchema.safeParse(raw);
  if (!parsed.success) return contract();
  const proposal = parsed.data;
  if (
    rosterDigest(proposal, proposal.members) !== proposal.snapshotDigest ||
    proposal.allConsented !== proposal.members.every((m) => m.consentedAt !== null)
  )
    return contract();
  return proposal;
}

export function createPartyHandlers(host: PartyHttpHost) {
  if (
    host?.version !== 'v1' ||
    ['requestId', 'actor', 'checkOrigin', 'rateLimit', 'create', 'propose', 'consent', 'read'].some(
      (name) => typeof host[name as keyof PartyHttpHost] !== 'function',
    )
  )
    contract();
  function correlation() {
    try {
      const id = InternalId.safeParse(host.requestId());
      if (id.success) return id.data;
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
      // Origin, then session, then throttle; the key and body are read only after all three passed.
      if (write) await host.checkOrigin(request);
      const actor = Actor.safeParse(await host.actor());
      if (!actor.success) contract();
      await host.rateLimit(actor.data!, write ? 'WRITE' : 'READ');
      if (new URL(request.url).searchParams.size) invalid();
      return Response.json(await work(actor.data!, id), { headers: partyHeaders });
    } catch (error) {
      return failure(error, id);
    }
  }
  async function pathId(id: string | Promise<string>) {
    const parsed = PathId.safeParse(await id);
    if (!parsed.success) return invalid();
    return parsed.data;
  }
  async function command<T>(
    request: Request,
    schema: z.ZodType<T>,
    actor: WorkActor,
    requestId: string,
    extra: Record<string, unknown> = {},
  ): Promise<WorkCommand & { input: T }> {
    const key = InternalId.safeParse(request.headers.get('idempotency-key'));
    if (!key.success) invalid();
    const body = schema.safeParse(await readBoundedJson(request, { maximumBytes: MAX_BODY_BYTES }));
    if (!body.success) invalid();
    return {
      actor,
      input: { ...body.data, ...extra } as T,
      idempotencyKey: key.data!,
      requestId,
    };
  }
  return {
    CREATE(request: Request) {
      return run(request, true, async (actor, requestId) => {
        const c = await command(request, CreatePartyInput, actor, requestId);
        const result = CreatePartyResultSchema.safeParse(await host.create(c));
        if (!result.success || result.data.party.name !== c.input.name) contract();
        return result.data;
      });
    },
    PROPOSE(request: Request, partyId: string | Promise<string>) {
      return run(request, true, async (actor, requestId) => {
        const party = await pathId(partyId);
        const c = await command(request, ProposeBody, actor, requestId, { partyId: party });
        const input = ProposePartyRosterInput.parse(c.input);
        const result = ProposePartyRosterResultSchema.safeParse(await host.propose(c));
        if (!result.success) return contract();
        const proposal = verifiedProposal(result.data.proposal);
        // The stored roster must be exactly what was sent, to the digest: no substituted member, role or amount.
        if (
          proposal.partyId !== party ||
          proposal.slotId !== input.slotId ||
          proposal.termsVersionId !== input.termsVersionId ||
          proposal.termsDigest !== input.termsDigest ||
          proposal.snapshotDigest !== rosterDigest(input, input.members)
        )
          contract();
        return result.data;
      });
    },
    CONSENT(request: Request, proposalId: string | Promise<string>) {
      return run(request, true, async (actor, requestId) => {
        const proposal = await pathId(proposalId);
        const c = await command(request, ConsentBody, actor, requestId, { proposalId: proposal });
        const input = RecordPartyConsentInput.parse(c.input);
        const result = RecordPartyConsentResultSchema.safeParse(await host.consent(c));
        if (
          !result.success ||
          result.data.consent.proposalId !== proposal ||
          result.data.consent.snapshotDigest !== input.snapshotDigest
        )
          contract();
        return result.data;
      });
    },
    READ(request: Request, proposalId: string | Promise<string>) {
      return run(request, false, async (actor) => {
        const target = await pathId(proposalId);
        const proposal = verifiedProposal(await host.read(actor, target));
        if (proposal.id !== target) contract();
        return proposal;
      });
    },
  };
}
