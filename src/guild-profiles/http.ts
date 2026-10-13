import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import { createErrorEnvelope, type ErrorCode } from '../contracts/protocol';
import { CommandReceiptError } from '../command-receipts';
import { readBoundedJson, JsonBodyFailure } from '../http-contracts/json';
import {
  SaveGuildDraftInputSchema,
  GuildDraftStorageError,
  type GuildDraftActor,
  type GuildDraftCommand,
} from './draft-storage-contracts';
export { GuildDraftHttpStateSchema, GuildDraftHttpSavedSchema } from './http-contracts';
import { GuildDraftHttpStateSchema, GuildDraftHttpSavedSchema } from './http-contracts';
export interface GuildDraftHttpHost {
  version: 'v1';
  actor(): Promise<GuildDraftActor>;
  checkOrigin(request: Request): Promise<void> | void;
  rateLimit(actor: GuildDraftActor): Promise<void>;
  read(actor: GuildDraftActor, id: string): Promise<unknown>;
  save(command: GuildDraftCommand): Promise<unknown>;
  requestId(): string;
}
export class GuildDraftHttpError extends Error {
  constructor(readonly status: 401 | 403 | 429) {
    super('HTTP_AUTHORITY_DENIED');
    this.name = 'GuildDraftHttpError';
  }
}
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
function failure(error: unknown, requestId: string) {
  let code: ErrorCode = 'SERVICE_UNAVAILABLE',
    status: number | undefined;
  if (error instanceof JsonBodyFailure) {
    code = 'INVALID_COMMAND';
    status = error.status;
  } else if (error instanceof GuildDraftHttpError) {
    code =
      error.status === 401
        ? 'AUTHENTICATION_REQUIRED'
        : error.status === 403
          ? 'FORBIDDEN'
          : 'RATE_LIMITED';
  } else if (error instanceof GuildDraftStorageError) {
    code =
      error.code === 'UNAUTHENTICATED'
        ? 'AUTHENTICATION_REQUIRED'
        : error.code === 'ACCOUNT_RESTRICTED'
          ? 'ACCOUNT_RESTRICTED'
          : error.code === 'WRONG_ACTOR'
            ? 'FORBIDDEN'
            : error.code === 'NOT_FOUND'
              ? 'NOT_FOUND'
              : error.code === 'REVISION_CONFLICT'
                ? 'REVISION_CHANGED'
                : error.code === 'SLUG_UNAVAILABLE'
                  ? 'DRAFT_SLUG_UNAVAILABLE'
                  : ['INVALID_INPUT', 'SLUG_IMMUTABLE'].includes(error.code)
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
  return Response.json(result.body, { status: status ?? result.status, headers });
}
/** Portable Request/Response adapter. Host authority is rebuilt from trusted current state. */
export function createGuildDraftHandlers(host: GuildDraftHttpHost) {
  if (host.version !== 'v1') throw new GuildDraftStorageError('STORAGE_CONTRACT');
  const requestId = () => {
    try {
      const p = InternalId.safeParse(host.requestId());
      if (p.success) return p.data;
    } catch {
      /* Fixed fallback reveals no private host detail. */
    }
    return crypto.randomUUID();
  };
  return {
    async POST(request: Request) {
      const id = requestId();
      try {
        await host.checkOrigin(request);
        const actor = await host.actor();
        await host.rateLimit(actor);
        const key = InternalId.safeParse(request.headers.get('idempotency-key'));
        if (!key.success) throw new JsonBodyFailure(422);
        const input = SaveGuildDraftInputSchema.safeParse(await readBoundedJson(request));
        if (!input.success) throw new JsonBodyFailure(422);
        const value = GuildDraftHttpSavedSchema.safeParse(
          await host.save({ actor, input: input.data, idempotencyKey: key.data, requestId: id }),
        );
        if (!value.success) throw new GuildDraftStorageError('STORAGE_CONTRACT');
        const snapshot = value.data.draft;
        if (
          snapshot.revision !== input.data.expectedRevision + 1 ||
          (input.data.guildDraftId !== null &&
            snapshot.id.toLowerCase() !== input.data.guildDraftId.toLowerCase()) ||
          snapshot.profile.name !== input.data.profile.name ||
          snapshot.profile.slug !== input.data.profile.slug ||
          snapshot.profile.description !== input.data.profile.description
        )
          throw new GuildDraftStorageError('STORAGE_CONTRACT');
        return Response.json(value.data, { headers });
      } catch (error) {
        return failure(error, id);
      }
    },
    async GET(_request: Request, draftId: string | Promise<string>) {
      const id = requestId();
      try {
        const actor = await host.actor();
        const parsed = z.uuid().safeParse(await draftId);
        if (!parsed.success) throw new JsonBodyFailure(422);
        const value = GuildDraftHttpStateSchema.safeParse(await host.read(actor, parsed.data));
        if (!value.success) throw new GuildDraftStorageError('STORAGE_CONTRACT');
        if (value.data.draft.id.toLowerCase() !== parsed.data.toLowerCase())
          throw new GuildDraftStorageError('STORAGE_CONTRACT');
        return Response.json(value.data, { headers });
      } catch (error) {
        return failure(error, id);
      }
    },
  };
}
