import { InternalId } from '../contracts/ids';
import { createErrorEnvelope, type ErrorCode } from '../contracts/protocol';
import { CommandReceiptError } from '../command-receipts/contracts';
import { JsonBodyFailure, readBoundedJson } from '../http-contracts/json';
import { GuildStorageError } from './guild-storage-contracts';

/** What every authenticated Guild management transport shares: headers, authority wrapper, failure and request mapping. */
export class GuildHttpAuthorityError extends Error {
  constructor(readonly status: 401 | 403 | 429) {
    super('HTTP_AUTHORITY_DENIED');
    this.name = 'GuildHttpAuthorityError';
  }
}
export const guildHttpHeaders = Object.freeze({
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
});
/**
 * Keyed by every storage code, so a new code is a compile error here instead of a silent 503. A transport lists only
 * the codes its commands can really produce; everything else stays an opaque 503 and never leaks detail.
 */
const BASE_STORAGE_CODES: Readonly<Record<GuildStorageError['code'], ErrorCode>> = {
  UNAUTHENTICATED: 'AUTHENTICATION_REQUIRED',
  ACCOUNT_RESTRICTED: 'ACCOUNT_RESTRICTED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  REVISION_CONFLICT: 'REVISION_CHANGED',
  WRITES_DISABLED: 'NOT_AVAILABLE',
  INVALID_INPUT: 'INVALID_COMMAND',
  GRANT_REVOKED: 'SERVICE_UNAVAILABLE',
  GUILD_EXISTS: 'SERVICE_UNAVAILABLE',
  SLUG_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  GRANT_LIMIT: 'SERVICE_UNAVAILABLE',
  TRANSFER_PENDING: 'SERVICE_UNAVAILABLE',
  UPDATE_LIMIT: 'SERVICE_UNAVAILABLE',
  STORAGE_CONTRACT: 'SERVICE_UNAVAILABLE',
  STORAGE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
};
export const guildStorageCodes = (
  extra: Readonly<Partial<Record<GuildStorageError['code'], ErrorCode>>> = {},
): Readonly<Record<GuildStorageError['code'], ErrorCode>> =>
  Object.freeze({ ...BASE_STORAGE_CODES, ...extra });
export function guildHttpFailure(
  error: unknown,
  requestId: string,
  codes: Readonly<Record<GuildStorageError['code'], ErrorCode>>,
) {
  let code: ErrorCode = 'SERVICE_UNAVAILABLE',
    status: number | undefined;
  if (error instanceof JsonBodyFailure) {
    code = 'INVALID_COMMAND';
    status = error.status;
  } else if (error instanceof GuildHttpAuthorityError) {
    code =
      error.status === 401
        ? 'AUTHENTICATION_REQUIRED'
        : error.status === 403
          ? 'FORBIDDEN'
          : 'RATE_LIMITED';
  } else if (error instanceof GuildStorageError) {
    code = codes[error.code];
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
    headers: guildHttpHeaders,
  });
}
/** A host must provide every named function and the v1 version marker, or the module refuses to start. */
export function assertGuildHttpHost(host: unknown, names: readonly string[]) {
  const value = host as Record<string, unknown> | null | undefined;
  if (value?.version !== 'v1' || names.some((name) => typeof value[name] !== 'function'))
    throw new GuildStorageError('STORAGE_CONTRACT');
}
/** The host's request id when it is a valid id, otherwise a fresh one; a faulty host can never break a response. */
export function guildCorrelation(host: { requestId(): string }) {
  try {
    const id = InternalId.safeParse(host.requestId());
    if (id.success) return id.data;
  } catch {}
  return crypto.randomUUID();
}
/** Idempotency key and bounded strict JSON, read only after origin, session and throttle passed. */
export async function readGuildCommand(request: Request) {
  const key = InternalId.safeParse(request.headers.get('idempotency-key'));
  if (!key.success) throw new JsonBodyFailure(422);
  return { key: key.data, json: await readBoundedJson(request) };
}
