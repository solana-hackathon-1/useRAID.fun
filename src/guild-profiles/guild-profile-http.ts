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
  EditGuildProfileInputSchema,
  GUILD_AUTHORITY_KINDS,
  GuildStorageError,
  ManagedGuildSchema,
  type GuildActor,
  type GuildCommand,
} from './guild-storage-contracts';

export class GuildProfileHttpError extends GuildHttpAuthorityError {
  constructor(status: 401 | 403 | 429) {
    super(status);
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
export const guildProfileHeaders = guildHttpHeaders;
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
// Not reachable from this route (no revoke, create, grant or transfer here); a leak would be a 503, never detail.
const STORAGE_CODES = guildStorageCodes();
const contract = () => new GuildStorageError('STORAGE_CONTRACT');
export function createGuildProfileHandlers(host: GuildProfileHttpHost) {
  assertGuildHttpHost(host, ['requestId', 'actor', 'checkOrigin', 'rateLimit', 'read', 'edit']);
  const correlation = () => guildCorrelation(host);
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
        return guildHttpFailure(error, id, STORAGE_CODES);
      }
    },
    async EDIT(request: Request) {
      const id = correlation();
      try {
        await host.checkOrigin(request);
        const actor = await host.actor();
        await host.rateLimit(actor, 'WRITE');
        const { key, json } = await readGuildCommand(request);
        const input = EditGuildProfileInputSchema.safeParse(json);
        if (!input.success) throw new JsonBodyFailure(422);
        const value = ResultSchema.safeParse(
          await host.edit({ actor, input: input.data, idempotencyKey: key, requestId: id }),
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
        return guildHttpFailure(error, id, STORAGE_CODES);
      }
    },
  };
}
