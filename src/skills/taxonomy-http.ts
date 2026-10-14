import { InternalId } from '../contracts/ids';
import { createErrorEnvelope, type ErrorCode } from '../contracts/protocol';
import { readBoundedJson, JsonBodyFailure } from '../http-contracts/json';
import { CommandReceiptError } from '../command-receipts';
import { SkillClaimContractError } from './contracts';
import {
  SkillTaxonomyActorSchema,
  SkillTaxonomyStorageError,
  type PublishSkillTaxonomyCommand,
  type SkillTaxonomyActor,
} from './taxonomy-storage-contracts';
import {
  SkillTaxonomyHttpInputSchema,
  SkillTaxonomyHttpPublishedSchema,
  SkillTaxonomyEditorStateSchema,
} from './taxonomy-http-contracts';
export * from './taxonomy-http-contracts';
export interface SkillTaxonomyHttpHost {
  readonly version: 'v1';
  /** Current X-authorized administrator. SQL must recheck authority under its locks. */
  actor(): Promise<SkillTaxonomyActor>;
  checkOrigin(request: Request): void | Promise<void>;
  rateLimit(actor: SkillTaxonomyActor): Promise<void>;
  publish(command: PublishSkillTaxonomyCommand): Promise<unknown>;
  requestId(): string;
}
export class SkillTaxonomyHttpError extends Error {
  constructor(readonly status: 401 | 403 | 429) {
    super('HTTP_AUTHORITY_DENIED');
    this.name = 'SkillTaxonomyHttpError';
  }
}
const privateHeaders = Object.freeze({ 'Cache-Control': 'private, no-store', Vary: 'Cookie' });
function failure(error: unknown, requestId: string) {
  let code: ErrorCode = 'SERVICE_UNAVAILABLE',
    status: number | undefined;
  if (error instanceof JsonBodyFailure) {
    code = 'INVALID_COMMAND';
    status = error.status;
  } else if (error instanceof SkillTaxonomyHttpError) {
    code =
      error.status === 401
        ? 'AUTHENTICATION_REQUIRED'
        : error.status === 403
          ? 'FORBIDDEN'
          : 'RATE_LIMITED';
  } else if (error instanceof SkillTaxonomyStorageError) {
    code =
      error.code === 'AUTHENTICATION_REQUIRED'
        ? 'AUTHENTICATION_REQUIRED'
        : error.code === 'ACCOUNT_RESTRICTED'
          ? 'ACCOUNT_RESTRICTED'
          : error.code === 'FORBIDDEN'
            ? 'FORBIDDEN'
            : error.code === 'INVALID_INPUT'
              ? 'INVALID_COMMAND'
              : 'SERVICE_UNAVAILABLE';
  } else if (error instanceof SkillClaimContractError) {
    code =
      error.code === 'REVISION_CHANGED'
        ? 'REVISION_CHANGED'
        : ['INVALID_INPUT', 'HISTORY_CONFLICT'].includes(error.code)
          ? 'INVALID_COMMAND'
          : 'SERVICE_UNAVAILABLE';
  } else if (error instanceof CommandReceiptError) {
    code =
      error.code === 'IDEMPOTENCY_KEY_REUSED'
        ? 'IDEMPOTENCY_KEY_REUSED'
        : error.code === 'INVALID_INPUT'
          ? 'INVALID_COMMAND'
          : 'SERVICE_UNAVAILABLE';
  }
  const result = createErrorEnvelope(code, requestId);
  return Response.json(result.body, { status: status ?? result.status, headers: privateHeaders });
}
function correlation(host: { requestId(): string }) {
  try {
    const result = InternalId.safeParse(host.requestId());
    if (result.success) return result.data;
  } catch {
    /* Do not expose host callback errors. */
  }
  return crypto.randomUUID();
}
/** Bounded private transport; current policy, durable receipts and transactions belong to the host. */
export function createSkillTaxonomyHandlers(host: SkillTaxonomyHttpHost) {
  if (host?.version !== 'v1') throw new SkillTaxonomyStorageError('STORAGE_CONTRACT');
  return {
    async POST(request: Request, id: string | Promise<string>) {
      const requestId = correlation(host);
      try {
        await host.checkOrigin(request);
        const current = SkillTaxonomyActorSchema.safeParse(await host.actor());
        if (!current.success) throw new SkillTaxonomyStorageError('STORAGE_CONTRACT');
        await host.rateLimit(current.data);
        const target = InternalId.safeParse(await id);
        const key = InternalId.safeParse(request.headers.get('idempotency-key'));
        if (!target.success || !key.success) throw new JsonBodyFailure(422);
        const parsed = SkillTaxonomyHttpInputSchema.safeParse(await readBoundedJson(request));
        if (!parsed.success) throw new JsonBodyFailure(422);
        const input = parsed.data;
        const output = SkillTaxonomyHttpPublishedSchema.safeParse(
          await host.publish({
            actor: current.data,
            input: { ...input, taxonomyId: target.data },
            idempotencyKey: key.data,
            requestId,
          }),
        );
        if (
          !output.success ||
          output.data.taxonomy.id !== target.data ||
          output.data.taxonomy.revision !== input.expectedRevision + 1 ||
          output.data.taxonomy.publishedByAccountId !== current.data.accountId ||
          JSON.stringify(output.data.taxonomy.skills) !== JSON.stringify(input.skills)
        )
          throw new SkillTaxonomyStorageError('STORAGE_CONTRACT');
        return Response.json(output.data, { headers: privateHeaders });
      } catch (error) {
        return failure(error, requestId);
      }
    },
  };
}
export interface SkillTaxonomyReadHost {
  readonly version: 'v1';
  actor(): Promise<SkillTaxonomyActor>;
  read(actor: SkillTaxonomyActor, id: string): Promise<unknown>;
  requestId(): string;
}
export function createSkillTaxonomyReadHandler(host: SkillTaxonomyReadHost) {
  if (host?.version !== 'v1') throw new SkillTaxonomyStorageError('STORAGE_CONTRACT');
  return {
    async GET(_request: Request, id: string | Promise<string>) {
      const requestId = correlation(host);
      try {
        const current = SkillTaxonomyActorSchema.safeParse(await host.actor());
        if (!current.success) throw new SkillTaxonomyStorageError('STORAGE_CONTRACT');
        const target = InternalId.safeParse(await id);
        if (!target.success) throw new JsonBodyFailure(422);
        const parsed = SkillTaxonomyEditorStateSchema.safeParse(
          await host.read(current.data, target.data),
        );
        if (
          !parsed.success ||
          parsed.data.taxonomyId !== target.data ||
          parsed.data.publisherAccountId !== current.data.accountId
        )
          throw new SkillTaxonomyStorageError('STORAGE_CONTRACT');
        return Response.json(parsed.data, { headers: privateHeaders });
      } catch (error) {
        return failure(error, requestId);
      }
    },
  };
}
