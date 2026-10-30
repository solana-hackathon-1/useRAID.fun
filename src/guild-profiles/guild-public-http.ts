import { InternalId } from '../contracts/ids';
import { PublicGuildSchema } from '../contracts/entities';
import { createErrorEnvelope, type ErrorCode } from '../contracts/protocol';
import {
  GUILD_UPDATE_PAGE_MAX,
  GuildStorageError,
  ListPublicGuildsInputSchema,
  PublicGuildDirectoryPageSchema,
  PublicGuildUpdatesPageSchema,
} from './guild-storage-contracts';
import { z } from 'zod';

export class GuildPublicHttpError extends Error {
  constructor(readonly status: 429) {
    super('HTTP_RATE_LIMITED');
    this.name = 'GuildPublicHttpError';
  }
}
/** Transport-neutral host: the host owns the feature flag, rate limiting, SQL and transaction. No session is involved. */
export interface GuildPublicHttpHost {
  readonly version: 'v1';
  requestId(): string;
  /** False while the feature flag is off; the routes then answer as if they did not exist. */
  available(): boolean;
  rateLimit(request: Request): void | Promise<void>;
  guild(slug: string): Promise<unknown>;
  updates(slug: string, query: { limit?: number; before?: string }): Promise<unknown>;
  /** Optional directory read (`GET /api/v1/guilds`); a host that omits it answers that route as not found. */
  guilds?(query: { limit?: number; after?: string }): Promise<unknown>;
}
/** Public data, but a withdrawn update must disappear at once: never serve a stale or shared-cache copy. */
export const guildPublicHeaders = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});
const respond = (code: ErrorCode, id: string) => {
  const result = createErrorEnvelope(code, id);
  return Response.json(result.body, { status: result.status, headers: guildPublicHeaders });
};
const slugSchema = PublicGuildSchema.shape.slug;
const UpdatesQuerySchema = z.strictObject({
  limit: z.number().int().min(1).max(GUILD_UPDATE_PAGE_MAX).optional(),
  before: z.uuid().optional(),
});
/** Strict query parsing: unknown or repeated parameters are refused rather than ignored. */
function readQuery(request: Request): unknown {
  const query: Record<string, string | number> = {};
  for (const [name, value] of new URL(request.url).searchParams) {
    if (name in query) return null;
    if (name === 'limit') {
      if (!/^\d{1,3}$/.test(value)) return null;
      query[name] = Number(value);
    } else query[name] = value;
  }
  return query;
}
export function createGuildPublicHandlers(host: GuildPublicHttpHost) {
  if (
    host?.version !== 'v1' ||
    ['requestId', 'available', 'rateLimit', 'guild', 'updates'].some(
      (name) => typeof host[name as keyof GuildPublicHttpHost] !== 'function',
    ) ||
    (host.guilds !== undefined && typeof host.guilds !== 'function')
  )
    throw new GuildStorageError('STORAGE_CONTRACT');
  function correlation() {
    try {
      const id = InternalId.safeParse(host.requestId());
      if (id.success) return id.data;
    } catch {}
    return crypto.randomUUID();
  }
  /** Shared envelope: method, flag, input, throttle, then the read; every failure is a safe, fixed answer. */
  async function run(request: Request, work: () => Promise<Response>) {
    const id = correlation();
    try {
      if (request.method !== 'GET') {
        return Response.json(
          {
            error: {
              code: 'METHOD_NOT_ALLOWED',
              message: 'Method not allowed.',
              retryable: false,
              requestId: id,
            },
          },
          { status: 405, headers: guildPublicHeaders },
        );
      }
      if (!host.available()) return respond('NOT_FOUND', id);
      await host.rateLimit(request);
      return (await work()) ?? respond('SERVICE_UNAVAILABLE', id);
    } catch (error) {
      if (error instanceof GuildPublicHttpError) return respond('RATE_LIMITED', id);
      if (error instanceof GuildStorageError && error.code === 'INVALID_INPUT')
        return respond('INVALID_COMMAND', id);
      if (error instanceof GuildStorageError && error.code === 'NOT_FOUND')
        return respond('NOT_FOUND', id);
      return respond('SERVICE_UNAVAILABLE', id);
    }
  }
  const unavailable = () => respond('SERVICE_UNAVAILABLE', correlation());
  return {
    GUILDS(request: Request) {
      return run(request, async () => {
        if (!host.guilds) return respond('NOT_FOUND', correlation());
        const query = ListPublicGuildsInputSchema.safeParse(readQuery(request));
        if (!query.success) return respond('INVALID_COMMAND', correlation());
        const result = PublicGuildDirectoryPageSchema.safeParse(await host.guilds(query.data));
        return result.success
          ? Response.json(result.data, { headers: guildPublicHeaders })
          : unavailable();
      });
    },
    GUILD(request: Request, slug: string) {
      return run(request, async () => {
        const target = slugSchema.safeParse(slug);
        if (!target.success || new URL(request.url).searchParams.size)
          return respond('INVALID_COMMAND', correlation());
        const profile = PublicGuildSchema.safeParse(await host.guild(target.data));
        // A malformed, over-shared or wrong-Guild host result is never forwarded to a visitor.
        return profile.success && profile.data.slug === target.data
          ? Response.json(profile.data, { headers: guildPublicHeaders })
          : unavailable();
      });
    },
    UPDATES(request: Request, slug: string) {
      return run(request, async () => {
        const target = slugSchema.safeParse(slug);
        const query = UpdatesQuerySchema.safeParse(readQuery(request));
        if (!target.success || !query.success) return respond('INVALID_COMMAND', correlation());
        const result = PublicGuildUpdatesPageSchema.safeParse(
          await host.updates(target.data, query.data),
        );
        return result.success
          ? Response.json(result.data, { headers: guildPublicHeaders })
          : unavailable();
      });
    },
  };
}
