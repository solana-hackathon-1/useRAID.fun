import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import { createErrorEnvelope, type ErrorCode } from '../contracts/protocol';
import { CommandReceiptError } from '../command-receipts/contracts';
import { JsonBodyFailure, readBoundedJson } from '../http-contracts/json';
import {
  AdjudicateSkillAssessmentAppealInputSchema,
  FileSkillAssessmentAppealInputSchema,
  SkillAppealError,
  SkillAssessmentAppealResultSchema,
  type SkillAppealActor,
  type SkillAppealCommand,
} from './contracts';

export class SkillAppealHttpAuthorityError extends Error {
  constructor(readonly status: 401 | 403 | 429) {
    super('HTTP_AUTHORITY_DENIED');
    this.name = 'SkillAppealHttpAuthorityError';
  }
}
export const skillAppealHttpHeaders = Object.freeze({
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
});
/**
 * Transport-neutral host: authority comes from the host's own session, never from the body. `file` and `adjudicate`
 * are the host's wiring of the storage commands with its own switch, windows and adjudicator allowlist; the transport
 * decides nothing about who may do what. There is deliberately no read here: what an adjudicator may see of a case
 * (statement, evidence) is a separate access decision and is not part of this module.
 */
export interface SkillAppealHttpHost {
  readonly version: 'v1';
  requestId(): string;
  actor(): Promise<SkillAppealActor>;
  checkOrigin(request: Request): Promise<void> | void;
  rateLimit(actor: SkillAppealActor): Promise<void> | void;
  file(command: SkillAppealCommand): Promise<unknown>;
  adjudicate(command: SkillAppealCommand): Promise<unknown>;
}
// Every refusal an adjudicator can get for independence or authority is the same opaque FORBIDDEN: the transport does
// not say which conflict applied.
const STORAGE_CODES: Readonly<Record<SkillAppealError['code'], ErrorCode>> = {
  INVALID_INPUT: 'INVALID_COMMAND',
  AUTHENTICATION_REQUIRED: 'AUTHENTICATION_REQUIRED',
  ACCOUNT_RESTRICTED: 'ACCOUNT_RESTRICTED',
  FORBIDDEN: 'FORBIDDEN',
  SELF_ADJUDICATION: 'FORBIDDEN',
  ORIGINAL_REVIEWER: 'FORBIDDEN',
  GUILD_RELATIONSHIP: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  REVISION_CHANGED: 'REVISION_CHANGED',
  WINDOW_CLOSED: 'APPEAL_WINDOW_CLOSED',
  APPEAL_EXISTS: 'APPEAL_EXISTS',
  ALREADY_DECIDED: 'APPEAL_ALREADY_DECIDED',
  WRITES_DISABLED: 'NOT_AVAILABLE',
  STORAGE_CONTRACT: 'SERVICE_UNAVAILABLE',
  STORAGE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
};
function failure(error: unknown, requestId: string) {
  let code: ErrorCode = 'SERVICE_UNAVAILABLE',
    status: number | undefined;
  if (error instanceof JsonBodyFailure) {
    code = 'INVALID_COMMAND';
    status = error.status;
  } else if (error instanceof SkillAppealHttpAuthorityError) {
    code =
      error.status === 401
        ? 'AUTHENTICATION_REQUIRED'
        : error.status === 403
          ? 'FORBIDDEN'
          : 'RATE_LIMITED';
  } else if (error instanceof SkillAppealError) {
    code = STORAGE_CODES[error.code];
  } else if (error instanceof CommandReceiptError) {
    code =
      error.code === 'IDEMPOTENCY_KEY_REUSED'
        ? 'IDEMPOTENCY_KEY_REUSED'
        : error.code === 'INVALID_INPUT'
          ? 'INVALID_COMMAND'
          : 'SERVICE_UNAVAILABLE';
  }
  const result = createErrorEnvelope(code, requestId);
  return Response.json(result.body, {
    status: status ?? result.status,
    headers: skillAppealHttpHeaders,
  });
}
function correlation(host: { requestId(): string }) {
  try {
    const id = InternalId.safeParse(host.requestId());
    if (id.success) return id.data;
  } catch {}
  return crypto.randomUUID();
}
const contract = () => new SkillAppealError('STORAGE_CONTRACT');
const DecisionBodySchema = z.strictObject({
  version: z.literal('v1'),
  outcome: z.enum(['UPHELD', 'DENIED']),
  reason: z.string(),
});
async function commandBody(request: Request) {
  if (new URL(request.url).searchParams.size) throw new JsonBodyFailure(422);
  const key = InternalId.safeParse(request.headers.get('idempotency-key'));
  if (!key.success) throw new JsonBodyFailure(422);
  return { key: key.data, json: await readBoundedJson(request) };
}

export function createSkillAppealHandlers(host: SkillAppealHttpHost) {
  const value = host as unknown as Record<string, unknown> | null | undefined;
  if (
    value?.version !== 'v1' ||
    ['requestId', 'actor', 'checkOrigin', 'rateLimit', 'file', 'adjudicate'].some(
      (name) => typeof value[name] !== 'function',
    )
  )
    throw contract();
  return {
    /** POST: the signed-in participant files one appeal against their own current decided assessment version. */
    async FILE(request: Request) {
      const requestId = correlation(host);
      try {
        await host.checkOrigin(request);
        const actor = await host.actor();
        await host.rateLimit(actor);
        const { key, json } = await commandBody(request);
        const input = FileSkillAssessmentAppealInputSchema.safeParse(json);
        if (!input.success) throw new JsonBodyFailure(422);
        const result = SkillAssessmentAppealResultSchema.safeParse(
          await host.file({ actor, input: input.data, idempotencyKey: key, requestId }),
        );
        if (
          !result.success ||
          result.data.appeal.assessmentReference.recordId !==
            input.data.expectedAssessmentReference.recordId
        )
          throw contract();
        return Response.json(result.data, { headers: skillAppealHttpHeaders });
      } catch (error) {
        return failure(error, requestId);
      }
    },
    /** POST: an allowlisted independent adjudicator decides one pending appeal; the appeal id comes from the path. */
    async ADJUDICATE(request: Request, appealId: string | Promise<string>) {
      const requestId = correlation(host);
      try {
        await host.checkOrigin(request);
        const actor = await host.actor();
        await host.rateLimit(actor);
        const target = z.uuid().safeParse(await appealId);
        if (!target.success) throw new JsonBodyFailure(422);
        const { key, json } = await commandBody(request);
        const body = DecisionBodySchema.safeParse(json);
        const input = AdjudicateSkillAssessmentAppealInputSchema.safeParse(
          body.success ? { ...body.data, appealId: target.data } : null,
        );
        if (!input.success) throw new JsonBodyFailure(422);
        const result = SkillAssessmentAppealResultSchema.safeParse(
          await host.adjudicate({ actor, input: input.data, idempotencyKey: key, requestId }),
        );
        if (
          !result.success ||
          result.data.appeal.id !== target.data ||
          result.data.appeal.state === 'PENDING'
        )
          throw contract();
        return Response.json(result.data, { headers: skillAppealHttpHeaders });
      } catch (error) {
        return failure(error, requestId);
      }
    },
  };
}
