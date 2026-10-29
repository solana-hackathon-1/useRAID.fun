import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import { createErrorEnvelope, type ErrorCode } from '../contracts/protocol';
import { CommandReceiptError } from '../command-receipts/contracts';
import { JsonBodyFailure, readBoundedJson } from '../http-contracts/json';
import {
  DraftGuildUpdateInputSchema,
  GuildStorageError,
  ManagedGuildUpdateSchema,
  type GuildActor,
  type GuildCommand,
} from './guild-storage-contracts';

export class GuildUpdatesHttpError extends Error {
  constructor(readonly status: 401 | 403 | 429) {
    super('HTTP_AUTHORITY_DENIED');
    this.name = 'GuildUpdatesHttpError';
  }
}
/** Transport-neutral host: authority comes from the host's own session, never from the request body. */
export interface GuildUpdatesHttpHost {
  readonly version: 'v1';
  requestId(): string;
  actor(): Promise<GuildActor>;
  checkOrigin(request: Request): Promise<void> | void;
  rateLimit(actor: GuildActor): Promise<void>;
  list(actor: GuildActor, guildId: string): Promise<unknown>;
  draft(command: GuildCommand): Promise<unknown>;
  publish(command: GuildCommand): Promise<unknown>;
  withdraw(command: GuildCommand): Promise<unknown>;
}
export const guildUpdatesHeaders = Object.freeze({
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
});
const StateSchema = z
  .strictObject({
    version: z.literal('v1'),
    updates: z.array(ManagedGuildUpdateSchema).max(100),
    writesAvailable: z.boolean(),
    unavailableReason: z.literal('DISABLED').nullable(),
  })
  .refine((s) => s.writesAvailable === (s.unavailableReason === null));
const ResultSchema = z.strictObject({
  status: z.enum(['EXECUTED', 'REPLAYED']),
  update: ManagedGuildUpdateSchema,
});
const StepBodySchema = z.strictObject({
  guildId: z.uuid(),
  action: z.enum(['PUBLISH', 'WITHDRAW']),
});
const STORAGE_CODES: Readonly<Record<string, ErrorCode>> = {
  UNAUTHENTICATED: 'AUTHENTICATION_REQUIRED',
  ACCOUNT_RESTRICTED: 'ACCOUNT_RESTRICTED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  REVISION_CONFLICT: 'REVISION_CHANGED',
  UPDATE_LIMIT: 'GUILD_UPDATE_LIMIT_REACHED',
  WRITES_DISABLED: 'NOT_AVAILABLE',
  INVALID_INPUT: 'INVALID_COMMAND',
};
function failure(error: unknown, requestId: string) {
  let code: ErrorCode = 'SERVICE_UNAVAILABLE',
    status: number | undefined;
  if (error instanceof JsonBodyFailure) {
    code = 'INVALID_COMMAND';
    status = error.status;
  } else if (error instanceof GuildUpdatesHttpError) {
    code =
      error.status === 401
        ? 'AUTHENTICATION_REQUIRED'
        : error.status === 403
          ? 'FORBIDDEN'
          : 'RATE_LIMITED';
  } else if (error instanceof GuildStorageError) {
    code = STORAGE_CODES[error.code] ?? 'SERVICE_UNAVAILABLE';
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
    headers: guildUpdatesHeaders,
  });
}
const contract = () => new GuildStorageError('STORAGE_CONTRACT');
export function createGuildUpdatesHandlers(host: GuildUpdatesHttpHost) {
  if (
    host?.version !== 'v1' ||
    ['requestId', 'actor', 'checkOrigin', 'rateLimit', 'list', 'draft', 'publish', 'withdraw'].some(
      (name) => typeof host[name as keyof GuildUpdatesHttpHost] !== 'function',
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
  /** Idempotency key and bounded strict JSON, read only after origin, session and throttle passed. */
  async function readCommand(request: Request) {
    const key = InternalId.safeParse(request.headers.get('idempotency-key'));
    if (!key.success) throw new JsonBodyFailure(422);
    return { key: key.data, json: await readBoundedJson(request) };
  }
  return {
    async LIST(request: Request) {
      const id = correlation();
      try {
        const actor = await host.actor();
        await host.rateLimit(actor);
        const params = new URL(request.url).searchParams;
        const guildId = z.uuid().safeParse(params.get('guildId'));
        if (!guildId.success || params.size !== 1 || params.getAll('guildId').length !== 1)
          throw new JsonBodyFailure(422);
        const value = StateSchema.safeParse(await host.list(actor, guildId.data));
        if (
          !value.success ||
          value.data.updates.some((u) => u.guildId.toLowerCase() !== guildId.data.toLowerCase())
        )
          throw contract();
        return Response.json(value.data, { headers: guildUpdatesHeaders });
      } catch (error) {
        return failure(error, id);
      }
    },
    async DRAFT(request: Request) {
      const id = correlation();
      try {
        await host.checkOrigin(request);
        const actor = await host.actor();
        await host.rateLimit(actor);
        const { key, json } = await readCommand(request);
        const input = DraftGuildUpdateInputSchema.safeParse(json);
        if (!input.success) throw new JsonBodyFailure(422);
        const value = ResultSchema.safeParse(
          await host.draft({ actor, input: input.data, idempotencyKey: key, requestId: id }),
        );
        const update = value.success ? value.data.update : null;
        if (
          !value.success ||
          update === null ||
          update.state !== 'DRAFT' ||
          update.guildId.toLowerCase() !== input.data.guildId ||
          update.title !== input.data.title ||
          update.body !== input.data.body
        )
          throw contract();
        return Response.json(value.data, { headers: guildUpdatesHeaders });
      } catch (error) {
        return failure(error, id);
      }
    },
    async STEP(request: Request, updateId: string | Promise<string>) {
      const id = correlation();
      try {
        await host.checkOrigin(request);
        const actor = await host.actor();
        await host.rateLimit(actor);
        const target = z.uuid().safeParse(await updateId);
        if (!target.success) throw new JsonBodyFailure(422);
        const { key, json } = await readCommand(request);
        const input = StepBodySchema.safeParse(json);
        if (!input.success) throw new JsonBodyFailure(422);
        const command = {
          actor,
          input: { guildId: input.data.guildId, updateId: target.data },
          idempotencyKey: key,
          requestId: id,
        };
        const value = ResultSchema.safeParse(
          await (input.data.action === 'PUBLISH' ? host.publish(command) : host.withdraw(command)),
        );
        const update = value.success ? value.data.update : null;
        if (
          !value.success ||
          update === null ||
          update.id.toLowerCase() !== target.data.toLowerCase() ||
          update.guildId.toLowerCase() !== input.data.guildId.toLowerCase() ||
          update.state !== (input.data.action === 'PUBLISH' ? 'PUBLISHED' : 'WITHDRAWN')
        )
          throw contract();
        return Response.json(value.data, { headers: guildUpdatesHeaders });
      } catch (error) {
        return failure(error, id);
      }
    },
  };
}
