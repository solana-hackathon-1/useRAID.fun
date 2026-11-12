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
  ActivateGuildInputSchema,
  GuildStorageError,
  ManagedGuildSchema,
  type GuildActor,
  type GuildCommand,
} from './guild-storage-contracts';

export class GuildActivationHttpError extends GuildHttpAuthorityError {
  constructor(status: 401 | 403 | 429) {
    super(status);
    this.name = 'GuildActivationHttpError';
  }
}
/**
 * Transport-neutral host: authority comes from the host's own session, never from the request body. `activate` is the
 * host's wiring of `activateGuild` with its own `authorizeActivation` policy; the transport decides nothing about who
 * may approve, it only checks origin, session and throttle and maps the result. There is no read here.
 */
export interface GuildActivationHttpHost {
  readonly version: 'v1';
  requestId(): string;
  actor(): Promise<GuildActor>;
  checkOrigin(request: Request): Promise<void> | void;
  rateLimit(actor: GuildActor, scope: 'READ' | 'WRITE'): Promise<void>;
  activate(command: GuildCommand): Promise<unknown>;
}
// The approver receives the Founder's account id (storage always returns it to an approver); nobody else sees this.
const ResultSchema = z.strictObject({
  status: z.enum(['EXECUTED', 'REPLAYED']),
  guild: ManagedGuildSchema.extend({ founderAccountId: z.string().min(1).max(200) }),
});
// GUILD_EXISTS and SLUG_UNAVAILABLE stay opaque: the base mapping answers SERVICE_UNAVAILABLE and leaks no detail.
const STORAGE_CODES = guildStorageCodes();
const contract = () => new GuildStorageError('STORAGE_CONTRACT');
export function createGuildActivationHandlers(host: GuildActivationHttpHost) {
  assertGuildHttpHost(host, ['requestId', 'actor', 'checkOrigin', 'rateLimit', 'activate']);
  return {
    async ACTIVATE(request: Request) {
      const requestId = guildCorrelation(host);
      try {
        await host.checkOrigin(request);
        const actor = await host.actor();
        await host.rateLimit(actor, 'WRITE');
        const { key, json } = await readGuildCommand(request);
        const input = ActivateGuildInputSchema.safeParse(json);
        if (!input.success) throw new JsonBodyFailure(422);
        const value = ResultSchema.safeParse(
          await host.activate({ actor, input: input.data, idempotencyKey: key, requestId }),
        );
        if (
          !value.success ||
          // An activation always records revision one, fresh or replayed.
          value.data.guild.revision !== 1 ||
          // Founder control is approved by someone other than the Founder; a result that says otherwise is a fault.
          value.data.guild.founderAccountId === actor.accountId
        )
          throw contract();
        return Response.json(value.data, { headers: guildHttpHeaders });
      } catch (error) {
        return guildHttpFailure(error, requestId, STORAGE_CODES);
      }
    },
  };
}
