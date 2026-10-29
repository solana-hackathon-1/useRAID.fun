import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import { createErrorEnvelope, type ErrorCode } from '../contracts/protocol';
import { CommandReceiptError } from '../command-receipts/contracts';
import { JsonBodyFailure, readBoundedJson } from '../http-contracts/json';
import {
  EditGuildProfileInputSchema,
  GUILD_AUTHORITY_KINDS,
  GuildStorageError,
  ManagedGuildSchema,
  type GuildActor,
  type GuildCommand,
} from './guild-storage-contracts';

export class GuildProfileHttpError extends Error {
  constructor(readonly status: 401 | 403 | 429) {
    super('HTTP_AUTHORITY_DENIED');
    this.name = 'GuildProfileHttpError';
  }
}
/** Transport-neutral host: authority comes from the host's own session, never from the request body. */
export interface GuildProfileHttpHost {
  readonly version: 'v1';
  requestId(): string;
  actor(): Promise<GuildActor>;
  checkOrigin(request: Request): Promise<void> | void;
  /** Reads and commands are throttled separately, so polling can never block an edit. */
  rateLimit(actor: GuildActor, scope: 'READ' | 'WRITE'): Promise<void>;
  read(actor: GuildActor, guildId: string): Promise<unknown>;
  edit(command: GuildCommand): Promise<unknown>;
}
export const guildProfileHeaders = Object.freeze({
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
});
const ViewSchema = z
  .strictObject({
    version: z.literal('v1'),
    guild: ManagedGuildSchema,
    authority: z.strictObject({
      founder: z.boolean(),
      kinds: z.array(z.enum(GUILD_AUTHORITY_KINDS as [string, ...string[]])).max(4),
    }),
    writesAvailable: z.boolean(),
    unavailableReason: z.literal('DISABLED').nullable(),
  })
  .refine((s) => s.writesAvailable === (s.unavailableReason === null));
// Only a managed read may redact the Founder id; a command result always carries it.
const ResultSchema = z.strictObject({
  status: z.enum(['EXECUTED', 'REPLAYED']),
  guild: ManagedGuildSchema.extend({ founderAccountId: z.string().min(1).max(200) }),
});
// Keyed by every storage code, so a new code is a compile error here instead of a silent 503.
const STORAGE_CODES: Readonly<Record<GuildStorageError['code'], ErrorCode>> = {
  UNAUTHENTICATED: 'AUTHENTICATION_REQUIRED',
  ACCOUNT_RESTRICTED: 'ACCOUNT_RESTRICTED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  REVISION_CONFLICT: 'REVISION_CHANGED',
  WRITES_DISABLED: 'NOT_AVAILABLE',
  INVALID_INPUT: 'INVALID_COMMAND',
  // Not reachable from this route (no revoke, create, grant or transfer here); a leak would be a 503, never detail.
  GRANT_REVOKED: 'SERVICE_UNAVAILABLE',
  GUILD_EXISTS: 'SERVICE_UNAVAILABLE',
  SLUG_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  GRANT_LIMIT: 'SERVICE_UNAVAILABLE',
  TRANSFER_PENDING: 'SERVICE_UNAVAILABLE',
  UPDATE_LIMIT: 'SERVICE_UNAVAILABLE',
  STORAGE_CONTRACT: 'SERVICE_UNAVAILABLE',
  STORAGE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
};
function failure(error: unknown, requestId: string) {
  let code: ErrorCode = 'SERVICE_UNAVAILABLE',
    status: number | undefined;
  if (error instanceof JsonBodyFailure) {
    code = 'INVALID_COMMAND';
    status = error.status;
  } else if (error instanceof GuildProfileHttpError) {
    code =
      error.status === 401
        ? 'AUTHENTICATION_REQUIRED'
        : error.status === 403
          ? 'FORBIDDEN'
          : 'RATE_LIMITED';
  } else if (error instanceof GuildStorageError) {
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
    headers: guildProfileHeaders,
  });
}
const contract = () => new GuildStorageError('STORAGE_CONTRACT');
export function createGuildProfileHandlers(host: GuildProfileHttpHost) {
  if (
    host?.version !== 'v1' ||
    ['requestId', 'actor', 'checkOrigin', 'rateLimit', 'read', 'edit'].some(
      (name) => typeof host[name as keyof GuildProfileHttpHost] !== 'function',
    )
  )
    throw contract();
  function correlation() {
    try {
      const id = InternalId.safeParse(host.requestId());
      if (id.success) return id.data;
    } catch {}
    return crypto.randomUUID();
  }
  return {
    async READ(request: Request) {
      const id = correlation();
      try {
        const actor = await host.actor();
        await host.rateLimit(actor, 'READ');
        const params = new URL(request.url).searchParams;
        const guildId = z.uuid().safeParse(params.get('guildId'));
        if (!guildId.success || params.size !== 1 || params.getAll('guildId').length !== 1)
          throw new JsonBodyFailure(422);
        const value = ViewSchema.safeParse(await host.read(actor, guildId.data));
        if (!value.success || value.data.guild.id.toLowerCase() !== guildId.data.toLowerCase())
          throw contract();
        return Response.json(value.data, { headers: guildProfileHeaders });
      } catch (error) {
        return failure(error, id);
      }
    },
    async EDIT(request: Request) {
      const id = correlation();
      try {
        await host.checkOrigin(request);
        const actor = await host.actor();
        await host.rateLimit(actor, 'WRITE');
        // Idempotency key and bounded strict JSON, read only after origin, session and throttle passed.
        const key = InternalId.safeParse(request.headers.get('idempotency-key'));
        if (!key.success) throw new JsonBodyFailure(422);
        const input = EditGuildProfileInputSchema.safeParse(await readBoundedJson(request));
        if (!input.success) throw new JsonBodyFailure(422);
        const value = ResultSchema.safeParse(
          await host.edit({ actor, input: input.data, idempotencyKey: key.data, requestId: id }),
        );
        const { name, description } = input.data.profile;
        // A replay returns the version its own command wrote, so fresh and replayed results match exactly.
        if (
          !value.success ||
          value.data.guild.id.toLowerCase() !== input.data.guildId.toLowerCase() ||
          value.data.guild.revision !== input.data.expectedRevision + 1 ||
          (name !== undefined && value.data.guild.name !== name) ||
          (description !== undefined && value.data.guild.description !== description)
        )
          throw contract();
        return Response.json(value.data, { headers: guildProfileHeaders });
      } catch (error) {
        return failure(error, id);
      }
    },
  };
}
