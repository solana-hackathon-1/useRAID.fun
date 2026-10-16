import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import { createErrorEnvelope, type ErrorCode } from '../contracts/protocol';
import { readBoundedJson, JsonBodyFailure } from '../http-contracts/json';
import { CommandReceiptError, canonicalRequestDigest } from '../command-receipts';
import {
  SkillTaxonomyActorSchema,
  SkillTaxonomyStorageError,
  type SkillTaxonomyActor,
} from './taxonomy-storage-contracts';
import { PracticeTrialStorageError } from './practice-trial-storage-contracts';
import {
  StartPracticeTrialInputSchema,
  PracticeTrialStartRecordSchema,
  PracticeTrialAttemptStorageError,
  type StartPracticeTrialCommand,
} from './practice-trial-attempt-storage';
import {
  SubmitPracticeTrialInputSchema,
  PracticeTrialSubmissionRecordSchema,
  PracticeTrialSubmissionStorageError,
  type SubmitPracticeTrialCommand,
} from './practice-trial-submission-storage';
import { PracticePortalCatalogSchema, PracticePortalError } from './practice-portal-contracts';
export class PracticePortalHttpError extends Error {
  constructor(readonly status: 401 | 403 | 429) {
    super('HTTP_AUTHORITY_DENIED');
    this.name = 'PracticePortalHttpError';
  }
}
export interface PracticePortalHttpHost {
  readonly version: 'v1';
  requestId(): string;
  actor(): Promise<SkillTaxonomyActor>;
  checkOrigin(request: Request): void | Promise<void>;
  rateLimit(actor: SkillTaxonomyActor): void | Promise<void>;
  list(actor: SkillTaxonomyActor, after: string | null): Promise<unknown>;
  read(actor: SkillTaxonomyActor, id: string): Promise<unknown>;
  start(command: StartPracticeTrialCommand): Promise<unknown>;
  submit(command: SubmitPracticeTrialCommand): Promise<unknown>;
}
export const practicePortalPrivateHeaders = Object.freeze({
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
});
const config = {
  version: z.literal('v1'),
  status: z.enum(['EXECUTED', 'REPLAYED']),
  writesAvailable: z.boolean(),
  unavailableReason: z.enum(['DISABLED']).nullable(),
};
const StartResult = z
  .strictObject({ ...config, start: PracticeTrialStartRecordSchema })
  .refine((v) => v.writesAvailable === (v.unavailableReason === null));
const SubmitResult = z
  .strictObject({ ...config, submission: PracticeTrialSubmissionRecordSchema })
  .refine((v) => v.writesAvailable === (v.unavailableReason === null));
export const PracticePortalProgressSchema = z
  .strictObject({
    version: z.literal('v1'),
    progress: z.enum(['STARTED', 'SUBMITTED']),
    start: PracticeTrialStartRecordSchema,
    submission: PracticeTrialSubmissionRecordSchema.nullable(),
  })
  .superRefine((v, ctx) => {
    const s = v.submission,
      a = v.start;
    if (
      (v.progress === 'SUBMITTED') !== (s !== null) ||
      (s &&
        (s.startId !== a.id ||
          s.participantId !== a.participantId ||
          s.skillId !== a.definition.skillId ||
          s.skillDomain !== a.definition.skillDomain ||
          !same(s.definitionReference, a.definition.reference) ||
          !same(s.rubricReference, a.definition.rubric.reference) ||
          Date.parse(s.submittedAt) < Date.parse(a.startedAt)))
    )
      ctx.addIssue({ code: 'custom', message: 'Incoherent original source.' });
  })
  .readonly();
export type PracticePortalProgress = z.output<typeof PracticePortalProgressSchema>;
function same(a: unknown, b: unknown) {
  return canonicalRequestDigest(a) === canonicalRequestDigest(b);
}
function invalid(): never {
  throw new JsonBodyFailure(422);
}
function contract(): never {
  throw new PracticePortalError('STORAGE_CONTRACT');
}
function correlation(host: PracticePortalHttpHost) {
  try {
    const v = InternalId.safeParse(host.requestId());
    if (v.success) return v.data;
  } catch {}
  return crypto.randomUUID();
}
function failure(e: unknown, id: string) {
  let code: ErrorCode = 'SERVICE_UNAVAILABLE',
    status: number | undefined;
  if (e instanceof JsonBodyFailure) {
    code = 'INVALID_COMMAND';
    status = e.status;
  } else if (e instanceof PracticePortalHttpError)
    code =
      e.status === 401
        ? 'AUTHENTICATION_REQUIRED'
        : e.status === 403
          ? 'FORBIDDEN'
          : 'RATE_LIMITED';
  else if (
    e instanceof PracticePortalError ||
    e instanceof PracticeTrialAttemptStorageError ||
    e instanceof PracticeTrialSubmissionStorageError ||
    e instanceof PracticeTrialStorageError ||
    e instanceof SkillTaxonomyStorageError ||
    e instanceof CommandReceiptError
  ) {
    const c = e.code;
    if (
      c === 'AUTHENTICATION_REQUIRED' ||
      c === 'ACCOUNT_RESTRICTED' ||
      c === 'FORBIDDEN' ||
      c === 'REVISION_CHANGED' ||
      c === 'IDEMPOTENCY_KEY_REUSED'
    )
      code = c;
    else if (c === 'INVALID_INPUT') code = 'INVALID_COMMAND';
    else if (['RESOURCE_UNAVAILABLE', 'DEFINITION_UNAVAILABLE', 'SKILL_UNAVAILABLE'].includes(c))
      code = 'NOT_FOUND';
    else if (c === 'ATTEMPT_LIMIT_REACHED') code = 'PRACTICE_ATTEMPT_LIMIT_REACHED';
    else if (c === 'COOLDOWN_ACTIVE') code = 'PRACTICE_COOLDOWN_ACTIVE';
    else if (c === 'ALREADY_SUBMITTED') code = 'PRACTICE_ALREADY_SUBMITTED';
    else if (c === 'ACCOMMODATION_UNAVAILABLE') code = 'PRACTICE_ACCOMMODATION_UNAVAILABLE';
  }
  const result = createErrorEnvelope(code, id);
  return Response.json(result.body, {
    status: status ?? result.status,
    headers: practicePortalPrivateHeaders,
  });
}
/** No Root state: host owns actual SQL/identity/current gates and durable command receipts. */
export function createPracticePortalHandlers(host: PracticePortalHttpHost) {
  if (
    host?.version !== 'v1' ||
    ['requestId', 'actor', 'checkOrigin', 'rateLimit', 'list', 'read', 'start', 'submit'].some(
      (k) => typeof host[k as keyof PracticePortalHttpHost] !== 'function',
    )
  )
    contract();
  async function run(
    request: Request,
    write: boolean,
    work: (actor: SkillTaxonomyActor, requestId: string) => Promise<unknown>,
  ) {
    const id = correlation(host);
    try {
      if (write) await host.checkOrigin(request);
      const a = SkillTaxonomyActorSchema.safeParse(await host.actor());
      if (!a.success) contract();
      await host.rateLimit(a.data);
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
          { status: 405, headers: practicePortalPrivateHeaders },
        );
      const result = await work(a.data, id);
      return Response.json(result, { headers: practicePortalPrivateHeaders });
    } catch (e) {
      return failure(e, id);
    }
  }
  function noQuery(request: Request) {
    if (new URL(request.url).searchParams.size) invalid();
  }
  function key(request: Request) {
    const k = InternalId.safeParse(request.headers.get('idempotency-key'));
    if (!k.success) invalid();
    return k.data;
  }
  return {
    LIST(request: Request) {
      return run(request, false, async (a) => {
        const q = new URL(request.url).searchParams;
        if ([...q.keys()].some((k) => k !== 'after') || q.getAll('after').length > 1) invalid();
        const after = q.get('after');
        if (after !== null && !InternalId.safeParse(after).success) invalid();
        const p = PracticePortalCatalogSchema.safeParse(await host.list(a, after));
        if (!p.success) contract();
        const v = p.data;
        const ids = v.trials.map((t) => t.definition.reference.recordId);
        if (
          new Set(ids).size !== ids.length ||
          v.trials.some(
            (t) => t.availability !== 'AVAILABLE' || t.taxonomyReference.recordId !== v.taxonomyId,
          ) ||
          (v.nextCursor !== null && (ids.length !== 50 || v.nextCursor !== ids[49]))
        )
          contract();
        return v;
      });
    },
    READ(request: Request, id: string | Promise<string>) {
      return run(request, false, async (a) => {
        noQuery(request);
        const target = z.uuid().safeParse(await id);
        if (!target.success) invalid();
        const raw = await host.read(a, target.data);
        if (raw === null) throw new PracticePortalError('RESOURCE_UNAVAILABLE');
        const p = PracticePortalProgressSchema.safeParse(raw);
        if (!p.success || p.data.start.id !== target.data) contract();
        return p.data;
      });
    },
    START(request: Request) {
      return run(request, true, async (a, requestId) => {
        noQuery(request);
        const idempotencyKey = key(request);
        const input = StartPracticeTrialInputSchema.safeParse(
          await readBoundedJson(request, { maximumBytes: 524288 }),
        );
        if (!input.success) invalid();
        const p = StartResult.safeParse(
          await host.start({ actor: a, input: input.data, idempotencyKey, requestId }),
        );
        if (
          !p.success ||
          !same(p.data.start.definition.reference, input.data.definitionReference) ||
          !same(p.data.start.accommodationReference, input.data.accommodationReference)
        )
          contract();
        return p.data;
      });
    },
    SUBMIT(request: Request, id: string | Promise<string>) {
      return run(request, true, async (a, requestId) => {
        noQuery(request);
        const target = z.uuid().safeParse(await id);
        const idempotencyKey = key(request);
        if (!target.success) invalid();
        const input = SubmitPracticeTrialInputSchema.safeParse(
          await readBoundedJson(request, { maximumBytes: 524288 }),
        );
        if (!input.success || input.data.startId !== target.data) invalid();
        const p = SubmitResult.safeParse(
          await host.submit({ actor: a, input: input.data, idempotencyKey, requestId }),
        );
        if (!p.success) contract();
        const s = p.data.submission,
          b = input.data;
        if (
          s.startId !== target.data ||
          !same(s.definitionReference, b.expectedDefinitionReference) ||
          !same(s.rubricReference, b.expectedRubricReference) ||
          s.answer !== b.answer ||
          s.explanation !== b.explanation ||
          !same(s.toolsUsed, b.toolsUsed) ||
          s.aiAssistanceUsed !== b.aiAssistanceUsed ||
          s.assistanceDisclosure !== b.assistanceDisclosure
        )
          contract();
        return p.data;
      });
    },
  };
}
