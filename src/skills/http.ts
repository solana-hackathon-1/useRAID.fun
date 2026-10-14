import { InternalId } from '../contracts/ids';
import { createErrorEnvelope, type ErrorCode } from '../contracts/protocol';
import { readBoundedJson, JsonBodyFailure } from '../http-contracts/json';
import { CommandReceiptError } from '../command-receipts';
import { SkillClaimContractError } from './contracts';
import {
  SkillClaimActorSchema,
  SkillClaimStorageError,
  type SkillClaimActor,
  type SaveSkillClaimCommand,
} from './claim-storage-contracts';
import { SkillTaxonomyStorageError } from './taxonomy-storage-contracts';
import {
  SkillClaimHttpInputSchema,
  SkillClaimHttpStateSchema,
  SkillClaimHttpSavedSchema,
  SkillCatalogHttpStateSchema,
} from './http-contracts';
export * from './http-contracts';
export interface SkillClaimHttpHost {
  readonly version: 'v1';
  actor(): Promise<SkillClaimActor>;
  checkOrigin(request: Request): void | Promise<void>;
  rateLimit(actor: SkillClaimActor): Promise<void>;
  read(actor: SkillClaimActor, skillId: string): Promise<unknown>;
  save(command: SaveSkillClaimCommand): Promise<unknown>;
  readCatalog(actor: SkillClaimActor, id: string): Promise<unknown>;
  requestId(): string;
}
export class SkillClaimHttpError extends Error {
  constructor(readonly status: 401 | 403 | 429) {
    super('HTTP_AUTHORITY_DENIED');
    this.name = 'SkillClaimHttpError';
  }
}
export const skillClaimPrivateHeaders = Object.freeze({
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
});
function failure(error: unknown, requestId: string) {
  let code: ErrorCode = 'SERVICE_UNAVAILABLE',
    status: number | undefined;
  if (error instanceof JsonBodyFailure) {
    code = 'INVALID_COMMAND';
    status = error.status;
  } else if (error instanceof SkillClaimHttpError)
    code =
      error.status === 401
        ? 'AUTHENTICATION_REQUIRED'
        : error.status === 403
          ? 'FORBIDDEN'
          : 'RATE_LIMITED';
  else if (error instanceof SkillClaimStorageError || error instanceof SkillTaxonomyStorageError)
    code =
      error.code === 'AUTHENTICATION_REQUIRED'
        ? 'AUTHENTICATION_REQUIRED'
        : error.code === 'ACCOUNT_RESTRICTED'
          ? 'ACCOUNT_RESTRICTED'
          : error.code === 'FORBIDDEN'
            ? 'FORBIDDEN'
            : error.code === 'RESOURCE_UNAVAILABLE'
              ? 'NOT_FOUND'
              : error.code === 'INVALID_INPUT'
                ? 'INVALID_COMMAND'
                : 'SERVICE_UNAVAILABLE';
  else if (error instanceof SkillClaimContractError)
    code =
      error.code === 'REVISION_CHANGED'
        ? 'REVISION_CHANGED'
        : error.code === 'AUTHENTICATION_REQUIRED'
          ? 'AUTHENTICATION_REQUIRED'
          : error.code === 'ACCOUNT_RESTRICTED'
            ? 'ACCOUNT_RESTRICTED'
            : error.code === 'FORBIDDEN'
              ? 'FORBIDDEN'
              : error.code === 'RESOURCE_UNAVAILABLE'
                ? 'NOT_FOUND'
                : ['INVALID_INPUT', 'HISTORY_CONFLICT', 'SKILL_UNAVAILABLE'].includes(error.code)
                  ? 'INVALID_COMMAND'
                  : 'SERVICE_UNAVAILABLE';
  else if (error instanceof CommandReceiptError)
    code =
      error.code === 'IDEMPOTENCY_KEY_REUSED'
        ? 'IDEMPOTENCY_KEY_REUSED'
        : error.code === 'INVALID_INPUT'
          ? 'INVALID_COMMAND'
          : 'SERVICE_UNAVAILABLE';
  const result = createErrorEnvelope(code, requestId);
  return Response.json(result.body, {
    status: status ?? result.status,
    headers: skillClaimPrivateHeaders,
  });
}
function requestId(host: SkillClaimHttpHost) {
  try {
    const parsed = InternalId.safeParse(host.requestId());
    if (parsed.success) return parsed.data;
  } catch {
    /* Never expose private callback errors. */
  }
  return crypto.randomUUID();
}
async function target(value: string | Promise<string>) {
  const parsed = InternalId.safeParse(await value);
  if (!parsed.success) throw new JsonBodyFailure(422);
  return parsed.data;
}
async function actor(host: SkillClaimHttpHost) {
  const parsed = SkillClaimActorSchema.safeParse(await host.actor());
  if (!parsed.success) throw new SkillClaimStorageError('STORAGE_CONTRACT');
  return parsed.data;
}
/** Private portable transport. Host/SQL owns current identity/permission/configuration/transactions. */
export function createSkillClaimHandlers(host: SkillClaimHttpHost) {
  if (host?.version !== 'v1') throw new SkillClaimStorageError('STORAGE_CONTRACT');
  return {
    async GET(_request: Request, id: string | Promise<string>) {
      const correlation = requestId(host);
      try {
        const current = await actor(host),
          skillId = await target(id);
        const parsed = SkillClaimHttpStateSchema.safeParse(await host.read(current, skillId));
        if (!parsed.success || parsed.data.skillId !== skillId)
          throw new SkillClaimStorageError('STORAGE_CONTRACT');
        return Response.json(parsed.data, { headers: skillClaimPrivateHeaders });
      } catch (error) {
        return failure(error, correlation);
      }
    },
    async POST(request: Request, id: string | Promise<string>) {
      const correlation = requestId(host);
      try {
        await host.checkOrigin(request);
        const current = await actor(host);
        await host.rateLimit(current);
        const skillId = await target(id),
          key = InternalId.safeParse(request.headers.get('idempotency-key'));
        if (!key.success) throw new JsonBodyFailure(422);
        const parsed = SkillClaimHttpInputSchema.safeParse(await readBoundedJson(request));
        if (!parsed.success) throw new JsonBodyFailure(422);
        const input = parsed.data;
        const output = SkillClaimHttpSavedSchema.safeParse(
          await host.save({
            actor: current,
            input: { ...input, skillId },
            idempotencyKey: key.data,
            requestId: correlation,
          }),
        );
        if (!output.success) throw new SkillClaimStorageError('STORAGE_CONTRACT');
        const c = output.data.claim;
        if (
          c.skillId !== skillId ||
          c.revision !== input.expectedClaimRevision + 1 ||
          c.taxonomyReference.recordId !== input.taxonomyId ||
          c.taxonomyReference.revision !== input.expectedTaxonomyRevision ||
          c.claimedLevel !== input.claimedLevel ||
          JSON.stringify(c.supportingReferences) !== JSON.stringify(input.supportingReferences)
        )
          throw new SkillClaimStorageError('STORAGE_CONTRACT');
        return Response.json(output.data, { headers: skillClaimPrivateHeaders });
      } catch (error) {
        return failure(error, correlation);
      }
    },
    async CATALOG_GET(_request: Request, id: string | Promise<string>) {
      const correlation = requestId(host);
      try {
        const current = await actor(host),
          taxonomyId = await target(id);
        const parsed = SkillCatalogHttpStateSchema.safeParse(
          await host.readCatalog(current, taxonomyId),
        );
        if (!parsed.success || parsed.data.taxonomyId !== taxonomyId)
          throw new SkillClaimStorageError('STORAGE_CONTRACT');
        return Response.json(parsed.data, { headers: skillClaimPrivateHeaders });
      } catch (error) {
        return failure(error, correlation);
      }
    },
  };
}
