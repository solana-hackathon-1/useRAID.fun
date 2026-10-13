import { InternalId } from '../contracts/ids';
import { createErrorEnvelope, type ErrorCode } from '../contracts/protocol';
import { CommandReceiptError } from '../command-receipts/contracts';
import { JsonBodyFailure } from '../http-contracts/json';
import { GuildDraftStorageError } from './draft-storage-contracts';
export class GuildDraftHttpError extends Error {
  constructor(readonly status: 401 | 403 | 429) {
    super('HTTP_AUTHORITY_DENIED');
    this.name = 'GuildDraftHttpError';
  }
}
export const guildPreparationHeaders = Object.freeze({
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
});
export function guildPreparationFailure(error: unknown, requestId: string) {
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
  return Response.json(result.body, {
    status: status ?? result.status,
    headers: guildPreparationHeaders,
  });
}

export function guildPreparationRequestId(host: { requestId(): string }): string {
  try {
    const parsed = InternalId.safeParse(host.requestId());
    if (parsed.success) return parsed.data;
  } catch {
    /* Safe fixed fallback, no private details. */
  }
  return crypto.randomUUID();
}
