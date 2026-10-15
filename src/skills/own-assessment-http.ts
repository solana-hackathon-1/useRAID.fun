import { InternalId } from '../contracts/ids';
import { createErrorEnvelope, type ErrorCode } from '../contracts/protocol';
import { SkillTaxonomyActorSchema, type SkillTaxonomyActor } from './taxonomy-storage-contracts';
import {
  OwnSkillAssessmentHttpStateSchema,
  OwnSkillAssessmentError,
} from './own-assessment-contracts';
export class OwnSkillAssessmentHttpError extends Error {
  constructor(readonly status: 401 | 403 | 429) {
    super('HTTP_AUTHORITY_DENIED');
    this.name = 'OwnSkillAssessmentHttpError';
  }
}
export interface OwnSkillAssessmentHttpHost {
  readonly version: 'v1';
  actor(): Promise<SkillTaxonomyActor>;
  rateLimit(actor: SkillTaxonomyActor): Promise<void> | void;
  read(actor: SkillTaxonomyActor, skillId: string): Promise<unknown>;
  requestId(): string;
}
export const ownAssessmentPrivateHeaders = Object.freeze({
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
});
function failResponse(error: unknown, requestId: string) {
  let code: ErrorCode = 'SERVICE_UNAVAILABLE';
  if (error instanceof OwnSkillAssessmentHttpError)
    code =
      error.status === 401
        ? 'AUTHENTICATION_REQUIRED'
        : error.status === 403
          ? 'FORBIDDEN'
          : 'RATE_LIMITED';
  else if (error instanceof OwnSkillAssessmentError)
    code =
      error.code === 'AUTHENTICATION_REQUIRED'
        ? 'AUTHENTICATION_REQUIRED'
        : error.code === 'ACCOUNT_RESTRICTED'
          ? 'ACCOUNT_RESTRICTED'
          : error.code === 'RESOURCE_UNAVAILABLE'
            ? 'NOT_FOUND'
            : error.code === 'INVALID_INPUT'
              ? 'INVALID_COMMAND'
              : 'SERVICE_UNAVAILABLE';
  const r = createErrorEnvelope(code, requestId);
  return Response.json(r.body, { status: r.status, headers: ownAssessmentPrivateHeaders });
}
/** Read-only own summary transport; host retains current identity/namespace/SQL authority. */
export function createOwnSkillAssessmentHandlers(host: OwnSkillAssessmentHttpHost) {
  if (
    host?.version !== 'v1' ||
    typeof host.actor !== 'function' ||
    typeof host.rateLimit !== 'function' ||
    typeof host.read !== 'function' ||
    typeof host.requestId !== 'function'
  )
    throw new OwnSkillAssessmentError('STORAGE_CONTRACT');
  return {
    async GET(request: Request, id: string | Promise<string>) {
      let correlation: string = crypto.randomUUID();
      try {
        const p = InternalId.safeParse(host.requestId());
        if (p.success) correlation = p.data;
      } catch {
        /* Private callback errors are never exposed. */
      }
      try {
        const a = SkillTaxonomyActorSchema.safeParse(await host.actor());
        if (!a.success) throw new OwnSkillAssessmentError('STORAGE_CONTRACT');
        await host.rateLimit(a.data);
        const target = InternalId.safeParse(await id);
        if (!target.success || new URL(request.url).searchParams.size)
          throw new OwnSkillAssessmentError('INVALID_INPUT');
        if (request.method !== 'GET')
          return Response.json(
            {
              error: {
                code: 'METHOD_NOT_ALLOWED',
                message: 'Method not allowed.',
                retryable: false,
                requestId: correlation,
              },
            },
            { status: 405, headers: ownAssessmentPrivateHeaders },
          );
        const parsed = OwnSkillAssessmentHttpStateSchema.safeParse(
          await host.read(a.data, target.data),
        );
        if (!parsed.success) throw new OwnSkillAssessmentError('STORAGE_CONTRACT');
        if (!parsed.data.readsAvailable) throw new OwnSkillAssessmentError('STORAGE_UNAVAILABLE');
        if (!parsed.data.view) throw new OwnSkillAssessmentError('RESOURCE_UNAVAILABLE');
        if (parsed.data.view.skillId !== target.data)
          throw new OwnSkillAssessmentError('STORAGE_CONTRACT');
        return Response.json(parsed.data, { headers: ownAssessmentPrivateHeaders });
      } catch (e) {
        return failResponse(e, correlation);
      }
    },
  };
}
