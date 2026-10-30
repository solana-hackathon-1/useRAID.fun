import { z } from 'zod';
import { JsonBodyFailure } from '../http-contracts/json';
import {
  assertGuildHttpHost,
  GuildHttpAuthorityError,
  guildCorrelation,
  guildHttpFailure,
  guildHttpHeaders,
  guildStorageCodes,
  readGuildCommand,
} from './guild-http-shared';
import {
  DraftGuildUpdateInputSchema,
  GuildStorageError,
  ManagedGuildUpdateSchema,
  type GuildActor,
  type GuildCommand,
} from './guild-storage-contracts';

export class GuildUpdatesHttpError extends GuildHttpAuthorityError {
  constructor(status: 401 | 403 | 429) {
    super(status);
    this.name = 'GuildUpdatesHttpError';
  }
}
/** Transport-neutral host: authority comes from the host's own session, never from the request body. */
export interface GuildUpdatesHttpHost {
  readonly version: 'v1';
  requestId(): string;
  actor(): Promise<GuildActor>;
  checkOrigin(request: Request): Promise<void> | void;
  /** Reads and commands are throttled separately, so polling can never block a publication or takedown. */
  rateLimit(actor: GuildActor, scope: 'READ' | 'WRITE'): Promise<void>;
  list(actor: GuildActor, guildId: string): Promise<unknown>;
  draft(command: GuildCommand): Promise<unknown>;
  publish(command: GuildCommand): Promise<unknown>;
  withdraw(command: GuildCommand): Promise<unknown>;
}
export const guildUpdatesHeaders = guildHttpHeaders;
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
// Not reachable from this route (no revoke, create, grant or transfer here); a leak would be a 503, never detail.
const STORAGE_CODES = guildStorageCodes({ UPDATE_LIMIT: 'GUILD_UPDATE_LIMIT_REACHED' });
/** A fresh step must land exactly; a replay may find the update already moved on, never backwards. */
function stateAllowed(
  status: 'EXECUTED' | 'REPLAYED',
  action: 'PUBLISH' | 'WITHDRAW',
  state: 'DRAFT' | 'PUBLISHED' | 'WITHDRAWN',
) {
  const exact = action === 'PUBLISH' ? 'PUBLISHED' : 'WITHDRAWN';
  if (state === exact) return true;
  return status === 'REPLAYED' && action === 'PUBLISH' && state === 'WITHDRAWN';
}
const contract = () => new GuildStorageError('STORAGE_CONTRACT');
export function createGuildUpdatesHandlers(host: GuildUpdatesHttpHost) {
  assertGuildHttpHost(host, [
    'requestId',
    'actor',
    'checkOrigin',
    'rateLimit',
    'list',
    'draft',
    'publish',
    'withdraw',
  ]);
  const correlation = () => guildCorrelation(host);
  const readCommand = readGuildCommand;
  return {
    async LIST(request: Request) {
      const id = correlation();
      try {
        const actor = await host.actor();
        await host.rateLimit(actor, 'READ');
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
        return guildHttpFailure(error, id, STORAGE_CODES);
      }
    },
    async DRAFT(request: Request) {
      const id = correlation();
      try {
        await host.checkOrigin(request);
        const actor = await host.actor();
        await host.rateLimit(actor, 'WRITE');
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
          // A replay returns the update as it is now; only a fresh draft must still be a draft.
          (value.data.status === 'EXECUTED' && update.state !== 'DRAFT') ||
          update.guildId.toLowerCase() !== input.data.guildId ||
          update.title !== input.data.title ||
          update.body !== input.data.body
        )
          throw contract();
        return Response.json(value.data, { headers: guildUpdatesHeaders });
      } catch (error) {
        return guildHttpFailure(error, id, STORAGE_CODES);
      }
    },
    async STEP(request: Request, updateId: string | Promise<string>) {
      const id = correlation();
      try {
        await host.checkOrigin(request);
        const actor = await host.actor();
        await host.rateLimit(actor, 'WRITE');
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
          !stateAllowed(value.data.status, input.data.action, update.state)
        )
          throw contract();
        return Response.json(value.data, { headers: guildUpdatesHeaders });
      } catch (error) {
        return guildHttpFailure(error, id, STORAGE_CODES);
      }
    },
  };
}
